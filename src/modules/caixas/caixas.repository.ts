import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { isValidObjectId, type Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { DadosCriarCaixa, DadosFecharCaixa } from "./caixas.types.js";
import { Caixa, type CaixaDocument } from "./schemas/caixa.schema.js";

@Injectable()
export class CaixasRepository implements OnModuleInit {
  private readonly logger = new Logger(CaixasRepository.name);

  constructor(@InjectModel(Caixa.name) private readonly caixaModel: Model<CaixaDocument>) {}

  /**
   * Etapa 18.3 — mesma auto-cura de índice de `MovimentosCaixaRepository`
   * (Etapa 10.14): a Etapa 18.2 achatou o schema (removeu o subdocumento
   * `abertura`), mas o Mongoose nunca remove sozinho um índice antigo que
   * deixou de existir no schema — só cria os que faltam. Sem isto, o índice
   * obsoleto `abertura.dataHora_1` continuaria no MongoDB indefinidamente ao
   * lado do novo `dataAbertura_1` (confirmado via auditoria contra
   * `mariela_dev_local`). `syncIndexes()` é idempotente e seguro a cada boot.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.caixaModel.syncIndexes();
    } catch (erro) {
      this.logger.error(
        "Falha ao sincronizar índices de caixas — verifique manualmente o estado dos índices antes de confiar na exclusividade de caixa aberto.",
        erro instanceof Error ? erro.stack : String(erro),
      );
    }
  }

  async criar(dados: DadosCriarCaixa): Promise<CaixaDocument> {
    try {
      return await this.caixaModel.create(dados);
    } catch (erro) {
      // O índice único parcial (`status: "aberto"`) é a proteção real contra
      // corrida: duas aberturas concorrentes só permitem UM insert — a
      // segunda cai aqui como erro de chave duplicada.
      if (this.ehErroDeChaveDuplicada(erro)) {
        throw ApiException.conflict("Já existe um caixa aberto.");
      }
      throw erro;
    }
  }

  async encontrarPorId(id: string): Promise<CaixaDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.caixaModel.findById(id).exec();
  }

  async encontrarPorIdOuFalhar(id: string): Promise<CaixaDocument> {
    const caixa = await this.encontrarPorId(id);
    if (!caixa) throw ApiException.notFound("Caixa não encontrado.");
    return caixa;
  }

  async encontrarAberto(): Promise<CaixaDocument | null> {
    return this.caixaModel.findOne({ status: "aberto" }).exec();
  }

  /** Todo o histórico de caixas — base da listagem híbrida (resumo calculado em memória, ver `CaixasService`). */
  async listarTodos(): Promise<CaixaDocument[]> {
    return this.caixaModel.find().exec();
  }

  async contarPorStatus(status: "aberto" | "fechado"): Promise<number> {
    return this.caixaModel.countDocuments({ status }).exec();
  }

  /** Soma de `diferenca` de todos os caixas já fechados (para `CaixaEstatisticas.diferencaAcumulada`). */
  async somarDiferencaFechados(): Promise<number> {
    const [resultado] = await this.caixaModel
      .aggregate<{ total: number }>([
        { $match: { status: "fechado" } },
        { $group: { _id: null, total: { $sum: "$diferenca" } } },
      ])
      .exec();
    return resultado?.total ?? 0;
  }

  /**
   * Transição atômica ABERTO→FECHADO: o filtro `status: "aberto"` faz parte
   * da MESMA operação que grava o fechamento — duas chamadas concorrentes de
   * fechamento (ex.: duplo clique/retry) só permitem UMA vencer; a segunda
   * recebe `null` (o service traduz em conflito) em vez de fechar duas vezes
   * ou sobrescrever o primeiro fechamento.
   */
  async fecharAtomico(id: string, fechamento: DadosFecharCaixa): Promise<CaixaDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.caixaModel
      .findOneAndUpdate({ _id: id, status: "aberto" }, { $set: { status: "fechado", ...fechamento } }, { returnDocument: "after" })
      .exec();
  }

  private ehErroDeChaveDuplicada(erro: unknown): boolean {
    return typeof erro === "object" && erro !== null && "code" in erro && (erro as { code: unknown }).code === 11000;
  }
}
