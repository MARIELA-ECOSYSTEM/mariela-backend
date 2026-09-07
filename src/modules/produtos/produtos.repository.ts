import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Error as MongooseErrors, isValidObjectId, type Model, type PipelineStage } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets, FacetOption } from "../../common/types/api-response.interface.js";
import { COM_ESTOQUE, EH_NOVIDADE, EM_PROMOCAO, FACETAS_PRODUTO, SEM_ESTOQUE, SEM_NOVIDADE, SEM_PROMOCAO } from "./produtos.constants.js";
import { combinarFiltros, filtroSempreAtivo, type SelecaoFacetas } from "./produtos-filtros.util.js";
import type { DadosCriarProduto, DadosNovaVariante } from "./produtos.types.js";
import { Produto, type ProdutoDocument } from "./schemas/produto.schema.js";

export interface ListarProdutosParams {
  busca?: string;
  ordenarPor: "nome" | "codProduto" | "precoVenda" | "quantidadeTotal" | "criadoEm";
  ordem: "asc" | "desc";
  selecao: SelecaoFacetas;
  page: number;
  limit: number;
}

export interface ListaProdutosResultado {
  itens: ProdutoDocument[];
  total: number;
  facets: ApiFacets;
}

/** Ordem de rótulos fixos de cada faceta booleana — mantém a saída estável mesmo com contagem zero. */
const ROTULOS_ESTOQUE = [COM_ESTOQUE, SEM_ESTOQUE];
const ROTULOS_PROMOCAO = [EM_PROMOCAO, SEM_PROMOCAO];
const ROTULOS_NOVIDADE = [EH_NOVIDADE, SEM_NOVIDADE];

@Injectable()
export class ProdutosRepository {
  constructor(@InjectModel(Produto.name) private readonly produtoModel: Model<ProdutoDocument>) {}

  async criar(dados: DadosCriarProduto): Promise<ProdutoDocument> {
    return this.produtoModel.create(dados);
  }

  async encontrarPorId(id: string): Promise<ProdutoDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.produtoModel.findOne({ _id: id, excluidoEm: null }).exec();
  }

  async encontrarPorIdOuFalhar(id: string): Promise<ProdutoDocument> {
    const produto = await this.encontrarPorId(id);
    if (!produto) throw ApiException.notFound("Produto não encontrado.");
    return produto;
  }

  /**
   * Adiciona uma variante de forma atômica: o filtro `"variantes.corNormalizada": { $ne }`
   * faz parte da MESMA operação `findOneAndUpdate` que insere a variante — não
   * existe janela de tempo entre "verificar duplicidade" e "gravar" onde uma
   * segunda requisição concorrente pudesse inserir a mesma cor. Se nenhum
   * documento casar o filtro, o retorno é `null` (produto não existe, já foi
   * excluído, ou a cor já está cadastrada — o service decide qual).
   */
  async adicionarVarianteAtomico(produtoId: string, variante: DadosNovaVariante): Promise<ProdutoDocument | null> {
    if (!isValidObjectId(produtoId)) return null;
    return this.produtoModel
      .findOneAndUpdate(
        { _id: produtoId, excluidoEm: null, "variantes.corNormalizada": { $ne: variante.corNormalizada } },
        { $push: { variantes: variante } },
        { returnDocument: "after" },
      )
      .exec();
  }

  /**
   * Aplica `mutar` sobre o documento e salva, usando o versionamento
   * otimista padrão do Mongoose (`__v`) como proteção de concorrência: se o
   * documento foi alterado por outra requisição entre a leitura e a gravação,
   * `save()` rejeita com `VersionError` e a operação é refeita do zero (nova
   * leitura, nova aplicação de `mutar`) — nunca sobrescreve um estado que não
   * viu. Cobre edição de variante, tamanhos e entrada/saída de estoque.
   */
  async salvarComRetentativa(
    id: string,
    mutar: (produto: ProdutoDocument) => void,
    tentativas = 3,
  ): Promise<ProdutoDocument> {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const produto = await this.encontrarPorIdOuFalhar(id);
      mutar(produto);
      try {
        return await produto.save();
      } catch (erro) {
        if (!(erro instanceof MongooseErrors.VersionError) || tentativa === tentativas) throw erro;
      }
    }
    // Inatingível: o loop sempre retorna ou lança na última tentativa.
    throw ApiException.conflict(
      "Não foi possível salvar as alterações: o produto foi modificado por outra operação simultânea. Tente novamente.",
    );
  }

  async listarComFacetas(params: ListarProdutosParams): Promise<ListaProdutosResultado> {
    const base = filtroSempreAtivo(params.busca);
    const filtroCompleto = combinarFiltros(base, params.selecao);

    const campoOrdenacao = params.ordenarPor === "precoVenda" ? "precoEfetivoOrdenacao" : params.ordenarPor;
    const direcao = params.ordem === "desc" ? -1 : 1;
    const skip = (params.page - 1) * params.limit;

    const pipeline: PipelineStage[] = [
      { $match: base },
      {
        $addFields: {
          precoEfetivoOrdenacao: {
            $cond: [
              { $and: ["$ehPromocao", { $gt: ["$precoPromocional", 0] }] },
              "$precoPromocional",
              "$precoVenda",
            ],
          },
        },
      },
      {
        $facet: {
          categorias: [
            { $match: combinarFiltros(base, params.selecao, FACETAS_PRODUTO.categorias) },
            { $group: { _id: "$categoria", count: { $sum: 1 } } },
          ],
          colecoes: [
            { $match: combinarFiltros(base, params.selecao, FACETAS_PRODUTO.colecoes) },
            { $match: { colecaoId: { $ne: null } } },
            { $group: { _id: "$colecaoId", count: { $sum: 1 } } },
          ],
          campanhas: [
            { $match: combinarFiltros(base, params.selecao, FACETAS_PRODUTO.campanhas) },
            { $match: { campanhaId: { $ne: null } } },
            { $group: { _id: "$campanhaId", count: { $sum: 1 } } },
          ],
          fornecedores: [
            { $match: combinarFiltros(base, params.selecao, FACETAS_PRODUTO.fornecedores) },
            { $match: { fornecedorId: { $ne: null } } },
            { $group: { _id: "$fornecedorId", count: { $sum: 1 } } },
          ],
          estoque: [
            { $match: combinarFiltros(base, params.selecao, FACETAS_PRODUTO.estoque) },
            {
              $group: {
                _id: { $cond: [{ $gt: ["$quantidadeTotal", 0] }, COM_ESTOQUE, SEM_ESTOQUE] },
                count: { $sum: 1 },
              },
            },
          ],
          promocao: [
            { $match: combinarFiltros(base, params.selecao, FACETAS_PRODUTO.promocao) },
            {
              $group: {
                _id: { $cond: ["$ehPromocao", EM_PROMOCAO, SEM_PROMOCAO] },
                count: { $sum: 1 },
              },
            },
          ],
          novidade: [
            { $match: combinarFiltros(base, params.selecao, FACETAS_PRODUTO.novidade) },
            {
              $group: {
                _id: { $cond: ["$ehNovidade", EH_NOVIDADE, SEM_NOVIDADE] },
                count: { $sum: 1 },
              },
            },
          ],
          total: [{ $match: filtroCompleto }, { $count: "valor" }],
          pagina: [
            { $match: filtroCompleto },
            { $sort: { [campoOrdenacao]: direcao } },
            { $skip: skip },
            { $limit: params.limit },
            // Campo só existe para permitir ordenar pelo preço vigente — nunca deve vazar na resposta pública.
            { $unset: "precoEfetivoOrdenacao" },
          ],
        },
      },
    ];

    const [resultado] = await this.produtoModel.aggregate(pipeline).exec();
    const total = (resultado?.total?.[0]?.valor as number | undefined) ?? 0;

    // Hidrata os documentos da página como instâncias reais do Model (para o
    // `toJSON` do schema — `_id`→`id`, campos ocultos — ser aplicado normalmente).
    const itens = (resultado?.pagina ?? []).map((doc: unknown) => this.produtoModel.hydrate(doc));

    const facets: ApiFacets = {
      [FACETAS_PRODUTO.categorias]: mapearOpcoes(resultado?.categorias),
      [FACETAS_PRODUTO.colecoes]: mapearOpcoes(resultado?.colecoes),
      [FACETAS_PRODUTO.campanhas]: mapearOpcoes(resultado?.campanhas),
      [FACETAS_PRODUTO.fornecedores]: mapearOpcoes(resultado?.fornecedores),
      [FACETAS_PRODUTO.estoque]: mapearOpcoesFixas(resultado?.estoque, ROTULOS_ESTOQUE),
      [FACETAS_PRODUTO.promocao]: mapearOpcoesFixas(resultado?.promocao, ROTULOS_PROMOCAO),
      [FACETAS_PRODUTO.novidade]: mapearOpcoesFixas(resultado?.novidade, ROTULOS_NOVIDADE),
    };

    return { itens, total, facets };
  }

  /** Usado pela listagem de Estoque — sem paginação nem facetas, mesma base de filtros simples de hoje. */
  async listarTodosAtivos(filtro: Record<string, unknown> = {}): Promise<ProdutoDocument[]> {
    return this.produtoModel.find({ excluidoEm: null, ...filtro }).exec();
  }
}

interface GrupoAgregado {
  _id: string;
  count: number;
}

function mapearOpcoes(grupos: GrupoAgregado[] | undefined): FacetOption[] {
  return (grupos ?? [])
    .filter((grupo) => grupo._id !== null && grupo._id !== undefined)
    .map((grupo) => ({ valor: grupo._id, count: grupo.count }))
    .sort((a, b) => a.valor.localeCompare(b.valor, "pt-BR"));
}

/** Garante que ambos os rótulos apareçam sempre, mesmo com contagem zero (facetas de 2 valores fixos). */
function mapearOpcoesFixas(grupos: GrupoAgregado[] | undefined, rotulos: string[]): FacetOption[] {
  const porValor = new Map((grupos ?? []).map((grupo) => [grupo._id, grupo.count]));
  return rotulos.map((valor) => ({ valor, count: porValor.get(valor) ?? 0 }));
}
