import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Error as MongooseErrors, isValidObjectId, type Model, type PipelineStage } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, FacetOption } from "../../common/types/api-response.interface.js";
import {
  FACETAS_VENDA,
  FAIXAS_VALOR,
  STATUS_VENDA,
  VALORES_CONDICOES,
  VALORES_FINANCEIRO,
  VALORES_PERIODO,
  type ChaveFacetaVenda,
  type Ordem,
  type OrdenarVendaPor,
} from "./vendas.constants.js";
import { combinarFiltros, condicaoFaceta, filtroSempreAtivo, type SelecaoFacetas } from "./vendas-filtros.util.js";
import type { DadosPersistirVenda } from "./vendas.types.js";
import { Venda, type VendaDocument } from "./schemas/venda.schema.js";

export interface ListarVendasParams {
  busca?: string;
  ordenarPor: OrdenarVendaPor;
  ordem: Ordem;
  selecao: SelecaoFacetas;
  page: number;
  limit: number;
}

export interface ListaVendasResultado {
  itens: VendaDocument[];
  total: number;
  facets: ApiFacets;
}

interface GrupoAgregado {
  _id: string | null;
  count: number;
}

const CAMPO_ORDENACAO: Record<OrdenarVendaPor, string> = {
  data: "dataVenda",
  valor: "valorFinal",
  pendente: "valorPendente",
};

@Injectable()
export class VendasRepository {
  constructor(@InjectModel(Venda.name) private readonly vendaModel: Model<VendaDocument>) {}

  /**
   * Cria a venda a partir de um documento já montado pelo service (`Venda`
   * completa: itens, pagamentos, parcelas, totais). Chamada pelo mecanismo
   * interno (`VendasService.criar`), hoje exposto via `POST /pdv/vendas`.
   *
   * Camada de segurança da idempotência sob concorrência real: a deduplicação
   * em memória de `VendasService.criar` cobre o caso comum (duas chamadas na
   * mesma instância do processo), mas não é garantida por construção — se,
   * ainda assim, duas gravações com a MESMA `idempotencyKey` chegarem aqui
   * (ex.: janela entre a checagem `encontrarPorIdempotencyKey` e o insert em
   * `criarInterno`), o índice único parcial do MongoDB garante que só uma
   * grava; a outra recebe erro de chave duplicada — capturado aqui e
   * traduzido na venda que efetivamente venceu a corrida, em vez de propagar
   * um 500. Mesmo padrão de `CaixasRepository.criar` para "só um caixa aberto".
   */
  async criar(dados: DadosPersistirVenda): Promise<VendaDocument> {
    try {
      return await this.vendaModel.create(dados as never);
    } catch (erro) {
      if (dados.idempotencyKey && this.ehErroDeIdempotencyKeyDuplicada(erro)) {
        const existente = await this.encontrarPorIdempotencyKey(dados.idempotencyKey);
        // Etapa 10.14: mesma cautela de `VendasService.verificarMesmaOperacaoDeCriacao`,
        // aplicada aqui à corrida rara de duas gravações concorrentes com a
        // MESMA chave — comparação leve (vendedor/caixa; a checagem completa,
        // item a item, já aconteceu antes de chegar aqui via a chamada comum
        // em `criarInterno`) só para nunca devolver silenciosamente a venda
        // de outro vendedor/caixa como se fosse o resultado desta chamada.
        if (existente && existente.vendedorId === dados.vendedorId && existente.caixaId === dados.caixaId) {
          return existente;
        }
        if (existente) {
          throw ApiException.conflict("Esta idempotencyKey já foi usada para registrar uma venda diferente. Gere uma nova chave para esta operação.");
        }
      }
      throw erro;
    }
  }

  async encontrarPorId(id: string): Promise<VendaDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.vendaModel.findById(id).exec();
  }

  async encontrarPorIdOuFalhar(id: string): Promise<VendaDocument> {
    const venda = await this.encontrarPorId(id);
    if (!venda) throw ApiException.notFound("Venda não encontrada.");
    return venda;
  }

  async encontrarPorIdempotencyKey(chave: string): Promise<VendaDocument | null> {
    return this.vendaModel.findOne({ idempotencyKey: chave }).exec();
  }

  /** Mesmo padrão de concorrência dos demais módulos: retry sob `VersionError` do versionamento otimista. */
  async salvarComRetentativa(id: string, mutar: (venda: VendaDocument) => void, tentativas = 3): Promise<VendaDocument> {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const venda = await this.encontrarPorIdOuFalhar(id);
      mutar(venda);
      try {
        return await venda.save();
      } catch (erro) {
        if (!(erro instanceof MongooseErrors.VersionError) || tentativa === tentativas) throw erro;
      }
    }
    throw ApiException.conflict("Não foi possível salvar as alterações: a venda foi modificada por outra operação simultânea. Tente novamente.");
  }

  /**
   * "Reivindica" atomicamente o direito de restaurar o estoque de UMA linha
   * de `cancelamento.itens` (Etapa 10.13) — `updateOne` com `arrayFilters`,
   * fora de `salvarComRetentativa`/versionamento otimista de propósito: é uma
   * escrita condicional autocontida (`WHERE restaurado = false`), do tipo
   * "compare-and-swap" — o mesmo padrão de idempotência por índice único já
   * usado em `VendasRepository.criar`/`MovimentosCaixaRepository.criar`,
   * aplicado aqui a um campo em vez de um índice.
   *
   * Devolve `true` só para quem GANHOU a reivindicação (deve prosseguir e
   * chamar `ProdutosService.ajustarQuantidadeTamanho`); `false` quando o item
   * já estava `restaurado` (outra chamada já tratou, ou é uma reconciliação
   * repetida) — o chamador NUNCA deve restaurar estoque quando isto devolve
   * `false`. Sob duas chamadas concorrentes tentando reconciliar o MESMO
   * item, o Mongo garante que só uma delas terá `modifiedCount === 1`.
   */
  async marcarItemDevolvidoRestaurado(vendaId: string, itemId: string): Promise<boolean> {
    const resultado = await this.vendaModel
      .updateOne(
        { _id: vendaId, "cancelamento.itens": { $elemMatch: { itemId, restaurado: false } } },
        { $set: { "cancelamento.itens.$[item].restaurado": true } },
        { arrayFilters: [{ "item.itemId": itemId, "item.restaurado": false }] },
      )
      .exec();
    return resultado.modifiedCount === 1;
  }

  async listarComFacetas(params: ListarVendasParams): Promise<ListaVendasResultado> {
    const base = filtroSempreAtivo(params.busca);
    const filtroCompleto = combinarFiltros(base, params.selecao);
    const campoOrdenacao = CAMPO_ORDENACAO[params.ordenarPor];
    const direcao = params.ordem === "desc" ? -1 : 1;
    const skip = (params.page - 1) * params.limit;

    const subFacetGrupo = (chave: ChaveFacetaVenda, campo: string) => [
      { $match: combinarFiltros(base, params.selecao, chave) },
      { $group: { _id: `$${campo}`, count: { $sum: 1 } } },
    ];

    const subFacetValor = (chave: ChaveFacetaVenda, valor: string) => {
      const baseGrupo = combinarFiltros(base, params.selecao, chave);
      const condicaoValor = condicaoFaceta(chave, [valor]) ?? {};
      return [{ $match: { $and: [baseGrupo, condicaoValor] } }, { $count: "valor" }];
    };
    const subFacetsPorValores = (chave: ChaveFacetaVenda, valores: readonly string[]) =>
      Object.fromEntries(valores.map((valor) => [`${chave}__${valor}`, subFacetValor(chave, valor)]));

    const pipeline: PipelineStage[] = [
      {
        $facet: {
          ...subFacetsPorValores(FACETAS_VENDA.status, STATUS_VENDA),
          ...subFacetsPorValores(FACETAS_VENDA.periodo, VALORES_PERIODO),
          vendedor: subFacetGrupo(FACETAS_VENDA.vendedor, "vendedorId"),
          cliente: [
            { $match: combinarFiltros(base, params.selecao, FACETAS_VENDA.cliente) },
            { $group: { _id: { $ifNull: ["$clienteId", "consumidor-final"] }, count: { $sum: 1 } } },
          ],
          pagamento: subFacetGrupo(FACETAS_VENDA.pagamento, "formaPagamento"),
          caixa: [
            { $match: combinarFiltros(base, params.selecao, FACETAS_VENDA.caixa) },
            { $match: { caixaCodigo: { $ne: null } } },
            { $group: { _id: "$caixaCodigo", count: { $sum: 1 } } },
          ],
          ...subFacetsPorValores(FACETAS_VENDA.valor, FAIXAS_VALOR.map((faixa) => faixa.valor)),
          ...subFacetsPorValores(FACETAS_VENDA.condicoes, VALORES_CONDICOES),
          ...subFacetsPorValores(FACETAS_VENDA.financeiro, VALORES_FINANCEIRO),
          total: [{ $match: filtroCompleto }, { $count: "valor" }],
          pagina: [{ $match: filtroCompleto }, { $sort: { [campoOrdenacao]: direcao } }, { $skip: skip }, { $limit: params.limit }],
        },
      },
    ];

    const [resultado] = await this.vendaModel.aggregate(pipeline).exec();
    const total = contarValor(resultado, "total");
    const itens = (resultado?.pagina ?? []).map((doc: unknown) => this.vendaModel.hydrate(doc));

    const facetsFixas = (chave: ChaveFacetaVenda, valores: readonly string[]): FacetOption[] =>
      valores.map((valor) => ({ valor, count: contarValor(resultado, `${chave}__${valor}`) }));

    const facets: ApiFacets = {
      [FACETAS_VENDA.status]: facetsFixas(FACETAS_VENDA.status, STATUS_VENDA),
      [FACETAS_VENDA.periodo]: facetsFixas(FACETAS_VENDA.periodo, VALORES_PERIODO),
      [FACETAS_VENDA.vendedor]: mapearOpcoes(resultado?.vendedor),
      [FACETAS_VENDA.cliente]: mapearOpcoes(resultado?.cliente),
      [FACETAS_VENDA.pagamento]: mapearOpcoes(resultado?.pagamento),
      [FACETAS_VENDA.caixa]: mapearOpcoes(resultado?.caixa),
      [FACETAS_VENDA.valor]: facetsFixas(
        FACETAS_VENDA.valor,
        FAIXAS_VALOR.map((faixa) => faixa.valor),
      ),
      [FACETAS_VENDA.condicoes]: facetsFixas(FACETAS_VENDA.condicoes, VALORES_CONDICOES),
      [FACETAS_VENDA.financeiro]: facetsFixas(FACETAS_VENDA.financeiro, VALORES_FINANCEIRO),
    };

    return { itens, total, facets };
  }

  /** Só os campos financeiros necessários para `CaixaEstatisticas`/`VendasEstatisticas` — nunca itens/histórico/pagamentos. */
  async encontrarTodasParaEstatisticas(): Promise<
    { status: string; valorFinal: number; valorDevolvido: number; totalItens: number; valorPendente: number; descontoTotal: number }[]
  > {
    return this.vendaModel
      .find({}, { status: 1, valorFinal: 1, valorDevolvido: 1, totalItens: 1, valorPendente: 1, descontoTotal: 1 })
      .lean()
      .exec();
  }

  /** Todas as vendas de um vendedor/cliente ainda válidas (não canceladas) — usado para recalcular `ultimaVenda`/`ultimaCompra` após um cancelamento. */
  async encontrarUltimaValidaPorVendedor(vendedorId: string): Promise<VendaDocument | null> {
    return this.vendaModel.findOne({ vendedorId, status: { $ne: "cancelada" } }).sort({ dataVenda: -1 }).exec();
  }

  async encontrarUltimaValidaPorCliente(clienteId: string): Promise<VendaDocument | null> {
    return this.vendaModel.findOne({ clienteId, status: { $ne: "cancelada" } }).sort({ dataVenda: -1 }).exec();
  }

  /**
   * Vendas com `dataVenda` no intervalo semiaberto `[inicio, fim)` — usado
   * pelo Dashboard para os recortes hoje/semana/mês (cada chamador passa o
   * intervalo já calculado; nunca a coleção inteira). Projeção mínima: só os
   * campos financeiros necessários para os agregados, nunca itens/histórico.
   */
  async encontrarNoIntervalo(inicio: Date, fim: Date): Promise<VendaResumoFinanceiro[]> {
    return this.vendaModel
      .find(
        { dataVenda: { $gte: inicio, $lt: fim } },
        { status: 1, dataVenda: 1, valorFinal: 1, vendedorId: 1, clienteId: 1 },
      )
      .lean()
      .exec();
  }

  /** As N vendas mais recentes (qualquer status) — usado por "Últimas vendas" do Dashboard. */
  async encontrarRecentes(limite: number): Promise<VendaDocument[]> {
    return this.vendaModel
      .find({})
      .select("-itens -pagamentos -parcelas -historico -cancelamento -observacao -idempotencyKey")
      .sort({ dataVenda: -1 })
      .limit(limite)
      .exec();
  }

  /**
   * `Venda` tem TRÊS índices únicos (`codigo`, `numero`, `idempotencyKey`
   * parcial) — só trata como "conflito de idempotência recuperável" quando o
   * índice em erro é especificamente `idempotencyKey`; uma colisão em
   * `codigo`/`numero` (nunca deveria acontecer, dado o gerador atômico de
   * sequência) é um erro real e deve propagar, não ser mascarada como retry.
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

export interface VendaResumoFinanceiro {
  status: string;
  dataVenda: Date;
  valorFinal: number;
  vendedorId: string;
  clienteId: string | null;
}

function contarValor(resultado: Record<string, { valor: number }[]> | undefined, chave: string): number {
  return resultado?.[chave]?.[0]?.valor ?? 0;
}

function mapearOpcoes(grupos: GrupoAgregado[] | undefined): FacetOption[] {
  return (grupos ?? [])
    .filter((grupo) => grupo._id !== null && grupo._id !== undefined)
    .map((grupo) => ({ valor: String(grupo._id), count: grupo.count }))
    .sort((a, b) => a.valor.localeCompare(b.valor, "pt-BR"));
}
