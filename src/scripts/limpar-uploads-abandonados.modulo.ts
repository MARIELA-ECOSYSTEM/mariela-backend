import { Injectable, Module, type DynamicModule } from "@nestjs/common";
import { InjectConnection, MongooseModule } from "@nestjs/mongoose";
import type { Connection, Types } from "mongoose";
import type { EstadoUploadMidia } from "../modules/media/media.constants.js";

/**
 * Fase 60.3 — contexto Nest EXCLUSIVO do comando `limpar-uploads-abandonados` (mesmo endurecimento das Fases
 * 56.4.3.1/60.2): conexão própria com `autoIndex`/`autoCreate` desligados, nenhum model compilado (só leituras e a
 * única escrita direto nas coleções), nenhum controller, nenhum `AppModule`. O storage NÃO vem daqui: o comando o
 * recebe já construído (R2 real a partir das variáveis, ou o falso nos testes).
 */

/** Campos lidos de `uploads_midia` — o necessário para decidir. */
export interface RegistroUpload {
  _id: string;
  produtoId: Types.ObjectId;
  chave: string;
  estado: EstadoUploadMidia;
  limpezaApos: Date;
  /** Fase 60.3.1 — dono e instante da reserva atual (`limpando`/`confirmando`); ausentes em registros antigos. */
  tokenReserva?: string | null;
  reservadoEm?: Date | null;
}

const PROJECAO_REGISTRO = { _id: 1, produtoId: 1, chave: 1, estado: 1, limpezaApos: 1, tokenReserva: 1, reservadoEm: 1 } as const;

function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Todas as consultas e a ÚNICA escrita da limpeza. Erros de leitura são propagados (nunca convertidos em
 * "não encontrado"): quem chama distingue "produto inexistente" (consulta bem-sucedida sem documento) de falha.
 */
@Injectable()
export class LeitorLimpezaUploads {
  constructor(@InjectConnection() private readonly conexao: Connection) {}

  private uploads() {
    return this.conexao.collection<RegistroUpload>("uploads_midia");
  }

  async listarRegistros(): Promise<RegistroUpload[]> {
    return this.uploads().find({}, { projection: PROJECAO_REGISTRO }).sort({ _id: 1 }).toArray();
  }

  async lerRegistro(uploadId: string): Promise<RegistroUpload | null> {
    return this.uploads().findOne({ _id: uploadId }, { projection: PROJECAO_REGISTRO });
  }

  /** Inclusive produtos excluídos logicamente (que continuam guardando sua galeria). */
  async produtoExiste(produtoId: Types.ObjectId): Promise<boolean> {
    return (await this.conexao.collection("produtos").findOne({ _id: produtoId }, { projection: { _id: 1 } })) !== null;
  }

  /**
   * Procura QUALQUER referência ao arquivo, em todos os produtos (não só no dono do registro) e nas vendas: mídia
   * com `_id` = uploadId ou `chave` igual; `variante.foto`/`variante.video` legados terminando na chave; foto
   * copiada num item de venda terminando na chave (histórico). Devolve a descrição da primeira encontrada, ou `null`.
   */
  async buscarReferencia(uploadId: string, chave: string): Promise<string | null> {
    const sufixo = new RegExp(`/${escaparRegex(chave)}$`);
    const produto = await this.conexao.collection("produtos").findOne(
      { $or: [{ "midias._id": uploadId }, { "midias.chave": chave }, { "variantes.foto": sufixo }, { "variantes.video": sufixo }] },
      { projection: { _id: 1 } },
    );
    if (produto) return `produto ${String(produto._id)}`;
    const venda = await this.conexao.collection("vendas").findOne({ "itens.foto": sufixo }, { projection: { _id: 1 } });
    return venda ? `venda ${String(venda._id)}` : null;
  }

  /**
   * Fase 60.3.1 — RESERVA da limpeza: `pendente` vencido (até `limiteVencimento`) → `limpando` com o token desta
   * execução. Escrita condicional no MESMO documento que a confirmação reserva (`confirmando`, só a partir de
   * `pendente` no prazo): no máximo uma das duas vence. `false` = outra execução/operação chegou antes.
   */
  async assumirLimpeza(uploadId: string, limiteVencimento: Date, token: string, agora: Date): Promise<boolean> {
    const resultado = await this.uploads().updateOne(
      { _id: uploadId, estado: "pendente", limpezaApos: { $lte: limiteVencimento } },
      // `limpezaIniciadaEm` é permanente: a partir daqui o registro nunca mais é reservável pela confirmação.
      { $set: { estado: "limpando", tokenReserva: token, reservadoEm: agora, limpezaIniciadaEm: agora } },
    );
    return resultado.modifiedCount === 1;
  }

  /**
   * Recupera uma reserva de limpeza INTERROMPIDA: `limpando` com o token antigo e reservada antes de
   * `limiteReserva` → novo token. A execução antiga perde a posse: todas as suas transições exigem o token antigo.
   */
  async recuperarLimpeza(uploadId: string, tokenAntigo: string | null, limiteReserva: Date, token: string, agora: Date): Promise<boolean> {
    const resultado = await this.uploads().updateOne(
      { _id: uploadId, estado: "limpando", tokenReserva: tokenAntigo, reservadoEm: { $lte: limiteReserva } },
      { $set: { tokenReserva: token, reservadoEm: agora } },
    );
    return resultado.modifiedCount === 1;
  }

  /** A reserva de limpeza ainda é desta execução (lida imediatamente antes da exclusão). */
  async possuiReserva(uploadId: string, token: string): Promise<boolean> {
    return (await this.uploads().findOne({ _id: uploadId, estado: "limpando", tokenReserva: token }, { projection: { _id: 1 } })) !== null;
  }

  /** `limpando` → `pendente` pelo dono da reserva (nada foi excluído: referência, falha de leitura ou de exclusão). */
  async liberarLimpeza(uploadId: string, token: string): Promise<boolean> {
    const resultado = await this.uploads().updateOne(
      { _id: uploadId, estado: "limpando", tokenReserva: token },
      { $set: { estado: "pendente", tokenReserva: null, reservadoEm: null } },
    );
    return resultado.modifiedCount === 1;
  }

  /** `limpando` → `descartado`, só pelo dono da reserva: `false` se a reserva foi recuperada por outra execução. */
  async marcarDescartado(uploadId: string, token: string): Promise<boolean> {
    const resultado = await this.uploads().updateOne({ _id: uploadId, estado: "limpando", tokenReserva: token }, { $set: { estado: "descartado", tokenReserva: null } });
    return resultado.modifiedCount === 1;
  }
}

export const OPCOES_DE_CONEXAO_DA_LIMPEZA = {
  autoIndex: false,
  autoCreate: false,
  serverSelectionTimeoutMS: 5_000,
  appName: "mariela-limpeza-uploads",
  monitorCommands: true,
} as const;

@Module({})
export class ComandoLimpezaUploadsModule {
  /** `aoConectar` recebe a conexão logo depois de aberta (instrumentação). */
  static paraUri(uri: string, aoConectar?: (conexao: Connection) => void): DynamicModule {
    return {
      module: ComandoLimpezaUploadsModule,
      imports: [
        MongooseModule.forRoot(uri, {
          ...OPCOES_DE_CONEXAO_DA_LIMPEZA,
          connectionFactory: (conexao: Connection) => {
            aoConectar?.(conexao);
            return conexao;
          },
        }),
      ],
      providers: [LeitorLimpezaUploads],
    };
  }
}
