import { Injectable, Logger } from "@nestjs/common";
import type { Types } from "mongoose";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import type { ApiMeta } from "../../../common/types/api-response.interface.js";
import { ClientesRepository } from "../../clientes/clientes.repository.js";
import type { OrigemBloqueioWhatsapp, TipoChaveBloqueioWhatsapp } from "../envios/envios-whatsapp.constants.js";
import { MensagensWhatsappRepository } from "../envios/mensagens-whatsapp.repository.js";
import type { BloqueioWhatsappDocument } from "../schemas/bloqueio-whatsapp.schema.js";
import { mascararTelefone } from "../utils/mascarar-telefone.util.js";
import { normalizarTelefoneParaWhatsapp } from "../utils/normalizar-telefone-whatsapp.util.js";
import { BloqueiosWhatsappRepository } from "./bloqueios-whatsapp.repository.js";

export interface BloqueioWhatsappDto {
  id: string;
  /** E.164 ou `waId`, sempre mascarado. */
  numeroMascarado: string;
  tipoChave: TipoChaveBloqueioWhatsapp;
  ativo: boolean;
  clienteId: string | null;
  origem: OrigemBloqueioWhatsapp;
  motivo: string | null;
  criadoEm: string;
  desbloqueadoEm: string | null;
  motivoDesbloqueio: string | null;
}

export interface StatusBloqueioClienteWhatsapp {
  bloqueado: boolean;
  telefoneMascarado: string | null;
  bloqueios: BloqueioWhatsappDto[];
}

function paraDto(b: BloqueioWhatsappDocument): BloqueioWhatsappDto {
  return {
    id: String(b._id),
    numeroMascarado: mascararTelefone(b.chave),
    tipoChave: b.tipoChave,
    ativo: b.ativo,
    clienteId: b.clienteId ? String(b.clienteId) : null,
    origem: b.origem,
    motivo: b.motivo,
    criadoEm: b.criadoEm.toISOString(),
    desbloqueadoEm: b.desbloqueadoEm ? b.desbloqueadoEm.toISOString() : null,
    motivoDesbloqueio: b.motivoDesbloqueio,
  };
}

/**
 * Fase 22.8.9.10.3 — bloqueio simplificado de contato (opt-out), POR NÚMERO (spec consolidada, item E).
 *
 * Chaves verificadas a cada envio: o E.164 do telefone ATUAL do cadastro + os `waId`s já devolvidos pelo provedor
 * para esse número ou cliente. Sem correspondência aproximada (nem variante do nono dígito — só seria implementada
 * com regra determinística validada; decisão da autorização desta fase).
 */
@Injectable()
export class BloqueiosWhatsappService {
  private readonly logger = new Logger(BloqueiosWhatsappService.name);
  /** Relógio substituível nos testes. */
  relogio: () => Date = () => new Date();

  constructor(
    private readonly repository: BloqueiosWhatsappRepository,
    private readonly mensagensRepository: MensagensWhatsappRepository,
    private readonly clientesRepository: ClientesRepository,
  ) {}

  /**
   * E.164 do número + `waId`s já devolvidos pelo provedor para ESSE número + (Fase 22.8.9.10.5) os MESMOS dígitos do
   * E.164 sem o `+` — a forma em que o webhook entrega `wa_id`/`from`. É igualdade exata de dígitos, NÃO
   * aproximação: nenhuma variante do nono dígito é gerada.
   */
  private async chavesDeVerificacao(telefoneE164: string): Promise<string[]> {
    const waIds = await this.mensagensRepository.waIdsConhecidos(telefoneE164);
    return [...new Set([telefoneE164, telefoneE164.replace(/^\+/, ""), ...waIds])];
  }

  /**
   * Fase 22.8.9.10.5 — bloqueio pelo identificador do WhatsApp recebido no webhook (`wa_id`/`from`), EXATAMENTE como
   * veio (chave `WAID`). Não depende de cliente cadastrado (`clienteId: null`) e é idempotente (índice único de
   * bloqueio ativo): eventos repetidos ou simultâneos resultam em UM bloqueio.
   */
  async bloquearWaId(waId: string, origem: OrigemBloqueioWhatsapp, motivo: string | null): Promise<{ bloqueio: BloqueioWhatsappDocument; criado: boolean }> {
    const resultado = await this.repository.bloquear({ chave: waId, tipoChave: "WAID", clienteId: null, origem, motivo, usuarioId: null }, this.relogio());
    if (resultado.criado) {
      this.logger.log(JSON.stringify({ evento: "whatsapp.bloqueio.criado", bloqueioId: String(resultado.bloqueio._id), origem, tipoChave: "WAID" }));
    }
    return resultado;
  }

  /** Bloqueio ativo que impede o envio para este número, ou `null`. */
  async bloqueioAtivo(telefoneE164: string): Promise<BloqueioWhatsappDocument | null> {
    const ativos = await this.repository.encontrarAtivosPorChaves(await this.chavesDeVerificacao(telefoneE164));
    return ativos[0] ?? null;
  }

  /** Bloqueio por número decidido pelo próprio sistema (ex.: opt-out de marketing informado pelo provedor). */
  async bloquearNumero(
    telefoneE164: string,
    clienteId: Types.ObjectId | null,
    origem: OrigemBloqueioWhatsapp,
    motivo: string | null,
  ): Promise<BloqueioWhatsappDocument> {
    const { bloqueio, criado } = await this.repository.bloquear(
      { chave: telefoneE164, tipoChave: "E164", clienteId, origem, motivo, usuarioId: null },
      this.relogio(),
    );
    if (criado) this.logger.log(JSON.stringify({ evento: "whatsapp.bloqueio.criado", bloqueioId: String(bloqueio._id), origem }));
    return bloqueio;
  }

  async statusDoCliente(clienteId: string): Promise<StatusBloqueioClienteWhatsapp> {
    const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(clienteId);
    let telefoneE164: string;
    try {
      telefoneE164 = normalizarTelefoneParaWhatsapp(cliente.telefone);
    } catch {
      // Telefone do cadastro não normalizável: não há número a bloquear nem para onde enviar.
      return { bloqueado: false, telefoneMascarado: null, bloqueios: [] };
    }
    const ativos = await this.repository.encontrarAtivosPorChaves(await this.chavesDeVerificacao(telefoneE164));
    return { bloqueado: ativos.length > 0, telefoneMascarado: mascararTelefone(telefoneE164), bloqueios: ativos.map(paraDto) };
  }

  /** Bloqueia o número ATUAL do cliente (idempotente: devolve o bloqueio existente). */
  async bloquearCliente(clienteId: string, motivo: string | null, usuarioId: string | null): Promise<{ bloqueio: BloqueioWhatsappDto; criado: boolean }> {
    const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(clienteId);
    const telefoneE164 = normalizarTelefoneParaWhatsapp(cliente.telefone);
    const { bloqueio, criado } = await this.repository.bloquear(
      { chave: telefoneE164, tipoChave: "E164", clienteId: cliente._id, origem: "ADMIN", motivo, usuarioId },
      this.relogio(),
    );
    if (criado) this.logger.log(JSON.stringify({ evento: "whatsapp.bloqueio.criado", bloqueioId: String(bloqueio._id), origem: "ADMIN", usuarioId }));
    return { bloqueio: paraDto(bloqueio), criado };
  }

  /** Desbloqueia TODOS os bloqueios ativos que hoje impedem o envio a este cliente (número atual e `waId`s conhecidos). */
  async desbloquearCliente(clienteId: string, motivo: string, usuarioId: string | null): Promise<StatusBloqueioClienteWhatsapp> {
    const cliente = await this.clientesRepository.encontrarPorIdOuFalhar(clienteId);
    const telefoneE164 = normalizarTelefoneParaWhatsapp(cliente.telefone);
    const ativos = await this.repository.encontrarAtivosPorChaves(await this.chavesDeVerificacao(telefoneE164));
    if (ativos.length === 0) throw ApiException.notFound("Nenhum bloqueio ativo para este cliente.");
    const agora = this.relogio();
    for (const b of ativos) {
      if (await this.repository.desbloquear(b._id, usuarioId, motivo, agora)) {
        this.logger.log(JSON.stringify({ evento: "whatsapp.bloqueio.removido", bloqueioId: String(b._id), usuarioId }));
      }
    }
    return this.statusDoCliente(clienteId);
  }

  async listar(somenteAtivos: boolean, page: number, limit: number): Promise<{ data: BloqueioWhatsappDto[]; meta: ApiMeta }> {
    const { itens, total } = await this.repository.listar(somenteAtivos, page, limit);
    return { data: itens.map(paraDto), meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  /** Desbloqueio por id — cobre bloqueios sem cliente associado. */
  async desbloquearPorId(id: string, motivo: string, usuarioId: string | null): Promise<BloqueioWhatsappDto> {
    const bloqueio = await this.repository.encontrarPorId(id);
    if (!bloqueio) throw ApiException.notFound("Bloqueio não encontrado.");
    if (!(await this.repository.desbloquear(bloqueio._id, usuarioId, motivo, this.relogio()))) {
      throw ApiException.conflict("Este bloqueio já foi removido.");
    }
    this.logger.log(JSON.stringify({ evento: "whatsapp.bloqueio.removido", bloqueioId: id, usuarioId }));
    const atualizado = await this.repository.encontrarPorId(id);
    return paraDto(atualizado ?? bloqueio);
  }
}
