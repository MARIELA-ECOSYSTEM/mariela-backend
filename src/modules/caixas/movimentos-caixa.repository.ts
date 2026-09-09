import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { isValidObjectId, type Model } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
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
export class MovimentosCaixaRepository implements OnModuleInit {
  private readonly logger = new Logger(MovimentosCaixaRepository.name);

  constructor(@InjectModel(MovimentoCaixa.name) private readonly movimentoModel: Model<MovimentoCaixaDocument>) {}

  /**
   * Etapa 10.14 — auto-cura de índice: sincroniza os índices efetivamente
   * criados no MongoDB com os declarados no schema atual a cada
   * inicialização do módulo. Resolve especificamente a migração do índice
   * de idempotência de `{caixaId, idempotencyKey}` (Etapa 10.10 e
   * anteriores) para `{idempotencyKey}` GLOBAL (Etapa 10.13): por padrão o
   * Mongoose só CRIA índices que faltam — nunca remove um índice antigo que
   * deixou de existir no schema, então sem isto o índice antigo (redundante,
   * mas inofensivo — é um subconjunto estritamente mais permissivo do novo)
   * continuaria ocupando espaço/tempo de escrita indefinidamente em
   * qualquer banco já em uso antes desta etapa (confirmado via auditoria:
   * exatamente esse índice antigo ainda presente no banco de testes).
   *
   * `syncIndexes()` é idempotente — não faz nada se já estiver sincronizado
   * — e seguro de rodar a cada boot. A auditoria da Etapa 10.14 confirmou o
   * banco livre de qualquer `idempotencyKey` duplicada entre caixas
   * diferentes, então este sync nunca falha por conflito de dados hoje; se
   * algum ambiente tiver dados incompatíveis no futuro, `syncIndexes()`
   * lançará ao tentar construir o índice único — capturado e logado aqui
   * (nunca derruba a inicialização do módulo inteiro por um problema de
   * manutenção de índice).
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.movimentoModel.syncIndexes();
    } catch (erro) {
      this.logger.error(
        "Falha ao sincronizar índices de movimentos_caixa — verifique manualmente se há idempotencyKey duplicada entre caixas diferentes antes de confiar na proteção de idempotência.",
        erro instanceof Error ? erro.stack : String(erro),
      );
    }
  }

  /**
   * Cria o movimento; se `idempotencyKey` já existir (retry de uma
   * requisição anterior), devolve o movimento JÁ CRIADO em vez de duplicar —
   * nunca lança erro para esse caso (é o comportamento esperado de uma chave
   * de idempotência, não uma falha).
   *
   * Tenta inserir diretamente (sem pré-checagem "existe? → insere", que tem
   * uma janela de corrida real: duas requisições concorrentes podem passar
   * pela checagem antes de qualquer uma terminar de escrever). O índice
   * único parcial `{idempotencyKey}` (Etapa 10.13 — GLOBAL, não mais por
   * caixa; ver `movimento-caixa.schema.ts`) garante que só uma gravação
   * vence; a outra recebe erro Mongo `11000`, capturado aqui e traduzido no
   * movimento que efetivamente venceu a corrida, em vez de propagar um 500 —
   * mesmo padrão já usado por `VendasRepository.criar` para `idempotencyKey`
   * de Venda.
   *
   * A busca do vencedor é SÓ por `idempotencyKey` (nunca mais filtrada por
   * `caixaId`): o movimento original pode ter sido lançado num caixa que já
   * fechou, diferente do `dados.caixaId` desta tentativa (o caixa atualmente
   * aberto) — filtrar por `caixaId` aqui faria essa busca não encontrar nada
   * e o erro 11000 vazaria como se fosse uma falha real.
   *
   * Etapa 10.14 — antes de devolver o vencedor como replay, confirma que ele
   * representa a MESMA operação (`tipo`/`sentido`/`valor`/`vendaId`/
   * `formaPagamento` batem — `caixaId` deliberadamente EXCLUÍDO da
   * comparação, ver acima). As chaves derivadas por `VendasService`
   * (prefixadas por `vendaId:operação:`) já não colidem entre operações
   * diferentes por construção, mas `CaixasService.registrarMovimento`
   * (entrada/saída MANUAL) aceita uma `idempotencyKey` bruta informada
   * livremente pelo chamador, sem esse prefixo — sem esta checagem, reusar a
   * mesma chave por engano em duas movimentações manuais diferentes faria a
   * segunda "suceder" silenciosamente devolvendo o resultado da primeira, em
   * vez de ser rejeitada. Reusa `ApiException.conflict` (mesmo código já
   * usado para os demais conflitos de idempotência do domínio).
   */
  async criar(dados: DadosCriarMovimento): Promise<ResultadoCriarMovimento> {
    try {
      const movimento = await this.movimentoModel.create(dados);
      return { movimento, duplicado: false };
    } catch (erro) {
      if (dados.idempotencyKey && this.ehErroDeIdempotencyKeyDuplicada(erro)) {
        const existente = await this.movimentoModel.findOne({ idempotencyKey: dados.idempotencyKey }).exec();
        if (existente) {
          if (!this.representaMesmaOperacao(existente, dados)) {
            throw ApiException.conflict("Esta idempotencyKey já foi usada para um movimento de caixa diferente. Gere uma nova chave para esta operação.");
          }
          return { movimento: existente, duplicado: true };
        }
      }
      throw erro;
    }
  }

  private representaMesmaOperacao(existente: MovimentoCaixaDocument, dados: DadosCriarMovimento): boolean {
    return (
      existente.tipo === dados.tipo &&
      existente.sentido === dados.sentido &&
      existente.valor === dados.valor &&
      existente.vendaId === dados.vendaId &&
      existente.formaPagamento === dados.formaPagamento
    );
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
   * `MovimentoCaixa` tem um único índice único hoje: `{idempotencyKey}`
   * (parcial/global desde a Etapa 10.13, só quando `idempotencyKey` é string
   * — ver o schema). Só trata
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
