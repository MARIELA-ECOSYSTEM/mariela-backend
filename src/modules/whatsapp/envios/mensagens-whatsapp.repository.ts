import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { isValidObjectId, type Model, Types } from "mongoose";
import { MensagemWhatsapp, type MensagemWhatsappDocument } from "../schemas/mensagem-whatsapp.schema.js";
import {
  PRAZO_ENVIANDO_MS,
  PRAZO_MINIMO_LIBERAR_INDETERMINADA_MS,
  PRAZO_POSSE_MS,
  type CodigoRecusaProvedor,
  type EstadoMensagemWhatsapp,
} from "./envios-whatsapp.constants.js";

export type DadosReservaMensagemWhatsapp = Pick<
  MensagemWhatsapp,
  | "idempotencyKey"
  | "hashConteudo"
  | "destinatarioTipo"
  | "destinatarioId"
  | "telefoneE164"
  | "templateChave"
  | "templateNomeMeta"
  | "templateIdioma"
  | "templateCategoria"
  | "origem"
  | "campanhaTipo"
  | "campanhaAno"
  | "chaveDeduplicacao"
  | "usuarioId"
>;

export interface FiltrosListagemMensagensWhatsapp {
  clienteId?: string;
  estado?: EstadoMensagemWhatsapp;
  campanhaAno?: number;
}

/**
 * Fase 22.8.9.10.3 — persistência de `mensagens_whatsapp`. Toda mudança de estado é UMA escrita condicional pelo
 * estado de origem (mesmo padrão de `UploadsMidiaRepository`): operações concorrentes nunca se desfazem, e quem
 * perde a corrida simplesmente não muda nada (`false`).
 *
 * Sequência do envio (spec 22.8.9.10.2 consolidada, item A):
 *   1. `reservar` (insert; índices únicos de `idempotencyKey` e `chaveDeduplicacao`) → `pendente`;
 *   2. `assumirEnvio` (`pendente` → `enviando`) — SÓ o dono da posse chama o provedor;
 *   3. `registrarAceita` / `registrarRecusa` / `registrarIndeterminada`.
 */
@Injectable()
export class MensagensWhatsappRepository {
  constructor(@InjectModel(MensagemWhatsapp.name) private readonly model: Model<MensagemWhatsappDocument>) {}

  /** Passo 1. Lança o erro de chave duplicada do MongoDB (código 11000) — o serviço decide pelo índice violado. */
  async reservar(dados: DadosReservaMensagemWhatsapp, agora: Date): Promise<MensagemWhatsappDocument> {
    return this.model.create({ ...dados, estado: "pendente", criadoEm: agora, atualizadoEm: agora });
  }

  async encontrarPorId(id: string): Promise<MensagemWhatsappDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.model.findById(id).exec();
  }

  async encontrarPorIdempotencyKey(idempotencyKey: string): Promise<MensagemWhatsappDocument | null> {
    return this.model.findOne({ idempotencyKey }).exec();
  }

  async encontrarPorChaveDeduplicacao(chaveDeduplicacao: string): Promise<MensagemWhatsappDocument | null> {
    return this.model.findOne({ chaveDeduplicacao }).exec();
  }

  /** Passo 2: `pendente` → `enviando`. Condicional: se o registro já não estiver `pendente`, ninguém assume. */
  async assumirEnvio(id: Types.ObjectId, agora: Date): Promise<boolean> {
    const r = await this.model
      .updateOne({ _id: id, estado: "pendente" }, { $set: { estado: "enviando", enviandoEm: agora, atualizadoEm: agora } })
      .exec();
    return r.modifiedCount === 1;
  }

  /** Passo 3 (sucesso). Aceita também a partir de `indeterminada` (resposta tardia depois da conversão por prazo). */
  async registrarAceita(id: Types.ObjectId, wamid: string, waId: string | null, agora: Date): Promise<boolean> {
    const r = await this.model
      .updateOne(
        { _id: id, estado: { $in: ["enviando", "indeterminada"] } },
        { $set: { estado: "aceita", wamid, waId, aceitaEm: agora, atualizadoEm: agora, erroCodigo: null, erroCodigoProvedor: null } },
      )
      .exec();
    return r.modifiedCount === 1;
  }

  /** Passo 3 (recusa comprovada pelo provedor). */
  async registrarRecusa(id: Types.ObjectId, codigo: CodigoRecusaProvedor, codigoProvedor: string | null, agora: Date): Promise<boolean> {
    const r = await this.model
      .updateOne(
        { _id: id, estado: { $in: ["enviando", "indeterminada"] } },
        { $set: { estado: "falha", erroCodigo: codigo, erroCodigoProvedor: codigoProvedor, falhaEm: agora, atualizadoEm: agora } },
      )
      .exec();
    return r.modifiedCount === 1;
  }

  /** Passo 3 (dúvida): só a partir de `enviando`. */
  async registrarIndeterminada(id: Types.ObjectId, codigoProvedor: string | null, agora: Date): Promise<boolean> {
    const r = await this.model
      .updateOne(
        { _id: id, estado: "enviando" },
        { $set: { estado: "indeterminada", erroCodigo: "INDETERMINADO", erroCodigoProvedor: codigoProvedor, atualizadoEm: agora } },
      )
      .exec();
    return r.modifiedCount === 1;
  }

  /**
   * Converte processos abandonados (chamada a cada leitura/listagem, sem agendador):
   * - `pendente` sem posse há mais de `PRAZO_POSSE_MS` → `falha`/`NAO_ENVIADA` (comprovadamente não enviada: a posse
   *   precede a chamada e é condicional, então um processo atrasado não consegue mais assumir);
   * - `enviando` há mais de `PRAZO_ENVIANDO_MS` → `indeterminada` (o pedido pode ter chegado ao provedor).
   */
  async converterAbandonadas(agora: Date): Promise<{ naoEnviadas: number; indeterminadas: number }> {
    const limitePosse = new Date(agora.getTime() - PRAZO_POSSE_MS);
    const limiteEnvio = new Date(agora.getTime() - PRAZO_ENVIANDO_MS);
    const naoEnviadas = await this.model
      .updateMany(
        { estado: "pendente", criadoEm: { $lt: limitePosse } },
        { $set: { estado: "falha", erroCodigo: "NAO_ENVIADA", falhaEm: agora, atualizadoEm: agora } },
      )
      .exec();
    const indeterminadas = await this.model
      .updateMany(
        { estado: "enviando", enviandoEm: { $lt: limiteEnvio } },
        { $set: { estado: "indeterminada", erroCodigo: "INDETERMINADO", atualizadoEm: agora } },
      )
      .exec();
    return { naoEnviadas: naoEnviadas.modifiedCount, indeterminadas: indeterminadas.modifiedCount };
  }

  /**
   * Liberação MANUAL de reenvio (item B). Condicional em UMA escrita: ainda não liberada, e `falha` ou `indeterminada`
   * com `enviandoEm` há pelo menos `PRAZO_MINIMO_LIBERAR_INDETERMINADA_MS`. Preserva o registro (estado inalterado) e
   * move a chave de campanha para `chaveDeduplicacaoLiberada`, liberando a reserva para UMA nova mensagem.
   */
  async liberar(doc: MensagemWhatsappDocument, usuarioId: string | null, motivo: string, agora: Date): Promise<boolean> {
    const limiteIndeterminada = new Date(agora.getTime() - PRAZO_MINIMO_LIBERAR_INDETERMINADA_MS);
    const r = await this.model
      .updateOne(
        {
          _id: doc._id,
          liberadaEm: null,
          chaveDeduplicacao: doc.chaveDeduplicacao,
          $or: [{ estado: "falha" }, { estado: "indeterminada", enviandoEm: { $lte: limiteIndeterminada } }],
        },
        {
          $set: {
            liberadaEm: agora,
            liberadaPor: usuarioId,
            motivoLiberacao: motivo,
            chaveDeduplicacao: null,
            chaveDeduplicacaoLiberada: doc.chaveDeduplicacao,
            atualizadoEm: agora,
          },
        },
      )
      .exec();
    return r.modifiedCount === 1;
  }

  async listar(filtros: FiltrosListagemMensagensWhatsapp, page: number, limit: number): Promise<{ itens: MensagemWhatsappDocument[]; total: number }> {
    const filtro: Record<string, unknown> = {};
    if (filtros.clienteId) filtro["destinatarioId"] = new Types.ObjectId(filtros.clienteId);
    if (filtros.estado) filtro["estado"] = filtros.estado;
    if (filtros.campanhaAno !== undefined) filtro["campanhaAno"] = filtros.campanhaAno;
    const [itens, total] = await Promise.all([
      this.model
        .find(filtro)
        .sort({ criadoEm: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.model.countDocuments(filtro).exec(),
    ]);
    return { itens, total };
  }

  /**
   * `waId`s já devolvidos pelo provedor para envios a ESTE número (verificação de bloqueio). Só pelo número, nunca
   * pelo cliente: se o cliente trocar de telefone, um bloqueio do número antigo não passa para o novo.
   */
  async waIdsConhecidos(telefoneE164: string): Promise<string[]> {
    const ids = await this.model.distinct("waId", { telefoneE164, waId: { $type: "string" } }).exec();
    return ids.filter((id): id is string => typeof id === "string");
  }
}
