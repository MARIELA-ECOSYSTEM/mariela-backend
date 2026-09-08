import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { isValidObjectId, type Model } from "mongoose";
import type { DadosCriarMovimento } from "./caixas.types.js";
import { MovimentoCaixa, type MovimentoCaixaDocument } from "./schemas/movimento-caixa.schema.js";

export interface ListarMovimentosParams {
  tipo: string[];
  responsavelId?: string;
  ordem: "asc" | "desc";
  page: number;
  limit: number;
}

export interface ListaMovimentosResultado {
  itens: MovimentoCaixaDocument[];
  total: number;
}

/** Resultado de `create()` com uma chave de idempotência: diz se foi uma criação nova ou um replay. */
export interface ResultadoCriarMovimento {
  movimento: MovimentoCaixaDocument;
  duplicado: boolean;
}

@Injectable()
export class MovimentosCaixaRepository {
  constructor(@InjectModel(MovimentoCaixa.name) private readonly movimentoModel: Model<MovimentoCaixaDocument>) {}

  /**
   * Cria o movimento; se `idempotencyKey` já existir para este caixa (retry
   * de uma requisição anterior), devolve o movimento JÁ CRIADO em vez de
   * duplicar — nunca lança erro para esse caso (é o comportamento esperado
   * de uma chave de idempotência, não uma falha).
   *
   * Tenta inserir diretamente (sem pré-checagem "existe? → insere", que tem
   * uma janela de corrida real: duas requisições concorrentes podem passar
   * pela checagem antes de qualquer uma terminar de escrever). O índice
   * único parcial `{caixaId, idempotencyKey}` (`movimento-caixa.schema.ts`)
   * garante que só uma gravação vence; a outra recebe erro Mongo `11000`,
   * capturado aqui e traduzido no movimento que efetivamente venceu a
   * corrida, em vez de propagar um 500 — mesmo padrão já usado por
   * `VendasRepository.criar` para `idempotencyKey` de Venda.
   */
  async criar(dados: DadosCriarMovimento): Promise<ResultadoCriarMovimento> {
    try {
      const movimento = await this.movimentoModel.create(dados);
      return { movimento, duplicado: false };
    } catch (erro) {
      if (dados.idempotencyKey && this.ehErroDeIdempotencyKeyDuplicada(erro)) {
        const existente = await this.movimentoModel
          .findOne({ caixaId: dados.caixaId, idempotencyKey: dados.idempotencyKey })
          .exec();
        if (existente) return { movimento: existente, duplicado: true };
      }
      throw erro;
    }
  }

  async listarTodosPorCaixa(caixaId: string): Promise<MovimentoCaixaDocument[]> {
    if (!isValidObjectId(caixaId)) return [];
    return this.movimentoModel.find({ caixaId }).exec();
  }

  /** Todo o histórico, de todos os caixas — base do resumo em memória da listagem (ver `CaixasService`). */
  async listarTodos(): Promise<MovimentoCaixaDocument[]> {
    return this.movimentoModel.find().exec();
  }

  async listarDoDia(inicio: Date, fim: Date): Promise<MovimentoCaixaDocument[]> {
    return this.movimentoModel.find({ dataHora: { $gte: inicio, $lt: fim } }).exec();
  }

  async listarPaginadoPorCaixa(caixaId: string, params: ListarMovimentosParams): Promise<ListaMovimentosResultado> {
    const filtro: Record<string, unknown> = { caixaId };
    if (params.tipo.length > 0) filtro["tipo"] = { $in: params.tipo };
    if (params.responsavelId) filtro["responsavelId"] = params.responsavelId;

    const direcao = params.ordem === "asc" ? 1 : -1;
    const skip = (params.page - 1) * params.limit;

    const [itens, total] = await Promise.all([
      this.movimentoModel.find(filtro).sort({ dataHora: direcao }).skip(skip).limit(params.limit).exec(),
      this.movimentoModel.countDocuments(filtro).exec(),
    ]);

    return { itens, total };
  }

  async recentesPorCaixa(caixaId: string, quantidade: number): Promise<MovimentoCaixaDocument[]> {
    return this.movimentoModel.find({ caixaId }).sort({ dataHora: -1 }).limit(quantidade).exec();
  }

  /**
   * `MovimentoCaixa` tem um único índice único hoje: `{caixaId, idempotencyKey}`
   * (parcial, só quando `idempotencyKey` é string — ver o schema). Só trata
   * como "conflito de idempotência recuperável" quando o índice em erro
   * INCLUI `idempotencyKey` — mesma técnica (e mesmo motivo) de
   * `VendasRepository.ehErroDeIdempotencyKeyDuplicada`: um 11000 em outro
   * índice único que venha a existir no futuro não deve ser mascarado como
   * retry, e sim propagar como o erro real que é.
   */
  private ehErroDeIdempotencyKeyDuplicada(erro: unknown): boolean {
    if (typeof erro !== "object" || erro === null || !("code" in erro) || (erro as { code: unknown }).code !== 11000) {
      return false;
    }
    const keyPattern = (erro as { keyPattern?: Record<string, unknown> }).keyPattern;
    if (keyPattern) return "idempotencyKey" in keyPattern;
    const mensagem = String((erro as { message?: unknown }).message ?? "");
    return mensagem.includes("idempotencyKey");
  }
}
