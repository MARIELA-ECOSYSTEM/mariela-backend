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
   */
  async criar(dados: DadosCriarMovimento): Promise<ResultadoCriarMovimento> {
    if (dados.idempotencyKey) {
      const existente = await this.movimentoModel
        .findOne({ caixaId: dados.caixaId, idempotencyKey: dados.idempotencyKey })
        .exec();
      if (existente) return { movimento: existente, duplicado: true };
    }
    const movimento = await this.movimentoModel.create(dados);
    return { movimento, duplicado: false };
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
}
