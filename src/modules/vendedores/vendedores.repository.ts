import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Error as MongooseErrors, isValidObjectId, type Model, type PipelineStage } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets } from "../../common/types/api-response.interface.js";
import {
  FACETAS_VENDEDOR,
  VALORES_FAIXA_VALOR,
  VALORES_FAIXA_VENDAS,
  VALORES_NASCIMENTO,
  VALORES_OBSERVACAO,
  VALORES_STATUS,
  VALORES_ULTIMA_VENDA,
  type ChaveFacetaVendedor,
  type Ordem,
  type OrdenarVendedorPor,
} from "./vendedores.constants.js";
import { combinarFiltros, condicaoFaceta, filtroSempreAtivo, type SelecaoFacetas } from "./vendedores-filtros.util.js";
import type { DadosCriarVendedor } from "./vendedores.types.js";
import { Vendedor, type VendedorDocument } from "./schemas/vendedor.schema.js";

export interface ListarVendedoresParams {
  busca?: string;
  ordenarPor: OrdenarVendedorPor;
  ordem: Ordem;
  selecao: SelecaoFacetas;
  page: number;
  limit: number;
}

export interface ListaVendedoresResultado {
  itens: VendedorDocument[];
  total: number;
  facets: ApiFacets;
}

interface ResultadoAggregate {
  total?: { valor: number }[];
  pagina?: unknown[];
  [chaveSubFaceta: string]: unknown;
}

@Injectable()
export class VendedoresRepository {
  constructor(@InjectModel(Vendedor.name) private readonly vendedorModel: Model<VendedorDocument>) {}

  async criar(dados: DadosCriarVendedor): Promise<VendedorDocument> {
    return this.vendedorModel.create(dados);
  }

  async encontrarPorId(id: string): Promise<VendedorDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.vendedorModel.findOne({ _id: id, excluidoEm: null }).exec();
  }

  async encontrarPorIdOuFalhar(id: string): Promise<VendedorDocument> {
    const vendedor = await this.encontrarPorId(id);
    if (!vendedor) throw ApiException.notFound("Vendedor(a) não encontrado(a).");
    return vendedor;
  }

  /** Base da checagem de telefone duplicado — ignora o próprio registro em atualizações. */
  async encontrarPorTelefoneNormalizado(telefoneNormalizado: string, ignorarId?: string): Promise<VendedorDocument | null> {
    const filtro: Record<string, unknown> = { telefoneNormalizado, excluidoEm: null };
    if (ignorarId) filtro["_id"] = { $ne: ignorarId };
    return this.vendedorModel.findOne(filtro).exec();
  }

  /** Todos os vendedores ativos, sem paginação — usado por agregações cross-módulo (ex.: Dashboard). */
  async encontrarTodosAtivos(): Promise<VendedorDocument[]> {
    return this.vendedorModel.find({ excluidoEm: null }).exec();
  }

  /**
   * Busca por `codigo` (credencial de login do MARIELA PDV) — SEM filtrar por
   * `excluidoEm`/`ativo` de propósito: o chamador (`VendedoresService.verificarSenha`)
   * precisa distinguir "não existe" de "existe mas está inativo/excluído" para
   * aplicar a mesma defesa de tempo constante contra enumeração já usada no
   * login do ADMIN (ver `AuthService.login`), rejeitando os dois casos com a
   * mesma mensagem genérica.
   */
  async encontrarPorCodigo(codigo: string): Promise<VendedorDocument | null> {
    return this.vendedorModel.findOne({ codigo }).exec();
  }

  /**
   * Mesmo padrão de concorrência de Clientes/Fornecedores: aplica `mutar` e
   * salva com o versionamento otimista do Mongoose (`__v`); se outra
   * requisição alterou o documento entre a leitura e a gravação, `save()`
   * rejeita com `VersionError` e a operação é refeita do zero.
   */
  async salvarComRetentativa(id: string, mutar: (vendedor: VendedorDocument) => void, tentativas = 3): Promise<VendedorDocument> {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const vendedor = await this.encontrarPorIdOuFalhar(id);
      mutar(vendedor);
      try {
        return await vendedor.save();
      } catch (erro) {
        if (!(erro instanceof MongooseErrors.VersionError) || tentativa === tentativas) throw erro;
      }
    }
    // Inatingível: o loop sempre retorna ou lança na última tentativa.
    throw ApiException.conflict(
      "Não foi possível salvar as alterações: o vendedor foi modificado por outra operação simultânea. Tente novamente.",
    );
  }

  async listarComFacetas(params: ListarVendedoresParams): Promise<ListaVendedoresResultado> {
    const base = filtroSempreAtivo(params.busca);
    const filtroCompleto = combinarFiltros(base, params.selecao);
    const direcao = params.ordem === "desc" ? -1 : 1;
    const skip = (params.page - 1) * params.limit;

    /** Um sub-facet por VALOR (não por grupo): os valores não são mutuamente exclusivos entre si dentro do grupo. */
    const subFacetValor = (chave: ChaveFacetaVendedor, valor: string): PipelineStage[] => {
      const baseGrupo = combinarFiltros(base, params.selecao, chave);
      const condicaoValor = condicaoFaceta(chave, [valor]) ?? {};
      return [{ $match: { $and: [baseGrupo, condicaoValor] } }, { $count: "valor" }];
    };

    const subFacetsPorGrupo = (chave: ChaveFacetaVendedor, valores: readonly string[]): Record<string, PipelineStage[]> =>
      Object.fromEntries(valores.map((valor) => [`${chave}__${valor}`, subFacetValor(chave, valor)]));

    const pipeline: PipelineStage[] = [
      {
        $facet: {
          ...subFacetsPorGrupo(FACETAS_VENDEDOR.status, VALORES_STATUS),
          ...subFacetsPorGrupo(FACETAS_VENDEDOR.vendas, VALORES_FAIXA_VENDAS),
          ...subFacetsPorGrupo(FACETAS_VENDEDOR.valor, VALORES_FAIXA_VALOR),
          ...subFacetsPorGrupo(FACETAS_VENDEDOR.ultimaVenda, VALORES_ULTIMA_VENDA),
          ...subFacetsPorGrupo(FACETAS_VENDEDOR.nascimento, VALORES_NASCIMENTO),
          ...subFacetsPorGrupo(FACETAS_VENDEDOR.observacao, VALORES_OBSERVACAO),
          total: [{ $match: filtroCompleto }, { $count: "valor" }],
          pagina: [{ $match: filtroCompleto }, { $sort: { [params.ordenarPor]: direcao } }, { $skip: skip }, { $limit: params.limit }],
        },
      },
    ];

    const [resultado] = (await this.vendedorModel.aggregate(pipeline).exec()) as ResultadoAggregate[];
    const total = contarValor(resultado, "total");

    // Hidrata os documentos da página como instâncias reais do Model (para o
    // `toJSON` do schema — `_id`→`id`, campos ocultos — ser aplicado normalmente).
    const itens = (resultado?.pagina ?? []).map((doc) => this.vendedorModel.hydrate(doc));

    const facets: ApiFacets = {
      [FACETAS_VENDEDOR.status]: VALORES_STATUS.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_VENDEDOR.status}__${valor}`),
      })),
      [FACETAS_VENDEDOR.vendas]: VALORES_FAIXA_VENDAS.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_VENDEDOR.vendas}__${valor}`),
      })),
      [FACETAS_VENDEDOR.valor]: VALORES_FAIXA_VALOR.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_VENDEDOR.valor}__${valor}`),
      })),
      [FACETAS_VENDEDOR.ultimaVenda]: VALORES_ULTIMA_VENDA.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_VENDEDOR.ultimaVenda}__${valor}`),
      })),
      [FACETAS_VENDEDOR.nascimento]: VALORES_NASCIMENTO.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_VENDEDOR.nascimento}__${valor}`),
      })),
      [FACETAS_VENDEDOR.observacao]: VALORES_OBSERVACAO.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_VENDEDOR.observacao}__${valor}`),
      })),
    };

    return { itens, total, facets };
  }
}

function contarValor(resultado: ResultadoAggregate | undefined, chave: string): number {
  const grupo = resultado?.[chave] as { valor: number }[] | undefined;
  return grupo?.[0]?.valor ?? 0;
}
