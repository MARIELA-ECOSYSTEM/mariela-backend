import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Error as MongooseErrors, isValidObjectId, type Model, type PipelineStage } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFacets } from "../../common/types/api-response.interface.js";
import {
  FACETAS_CLIENTE,
  JANELAS_RECENCIA,
  VALORES_ANIVERSARIO,
  VALORES_HISTORICO,
  VALORES_OBSERVACAO,
  type ChaveFacetaCliente,
  type Ordem,
  type OrdenarClientePor,
} from "./clientes.constants.js";
import { combinarFiltros, condicaoFaceta, filtroSempreAtivo, type SelecaoFacetas } from "./clientes-filtros.util.js";
import type { DadosCriarCliente } from "./clientes.types.js";
import { Cliente, type ClienteDocument } from "./schemas/cliente.schema.js";

export interface ListarClientesParams {
  busca?: string;
  ordenarPor: OrdenarClientePor;
  ordem: Ordem;
  selecao: SelecaoFacetas;
  page: number;
  limit: number;
}

export interface ListaClientesResultado {
  itens: ClienteDocument[];
  total: number;
  facets: ApiFacets;
}

interface ResultadoAggregate {
  total?: { valor: number }[];
  pagina?: unknown[];
  [chaveSubFaceta: string]: unknown;
}

@Injectable()
export class ClientesRepository {
  constructor(@InjectModel(Cliente.name) private readonly clienteModel: Model<ClienteDocument>) {}

  /**
   * `ClientesService.criar` já checa telefone duplicado ANTES de chamar isto
   * (defesa primária, mensagem de erro melhor). Este `catch` é só a rede de
   * segurança para a corrida rara entre essa checagem e a gravação (duas
   * criações simultâneas com o mesmo telefone) — quem perde a corrida esbarra
   * no índice único parcial de `telefoneNormalizado` (`erro 11000`) e, sem
   * isto, receberia um 500 cru em vez do 409 já usado pelo resto do domínio
   * para este mesmo caso (Etapa 13.2). Nunca mascara outro tipo de erro:
   * só traduz especificamente a colisão desse índice.
   */
  async criar(dados: DadosCriarCliente): Promise<ClienteDocument> {
    try {
      return await this.clienteModel.create(dados);
    } catch (erro) {
      if (this.ehErroDeTelefoneDuplicado(erro)) {
        throw ApiException.conflict("Já existe um cliente cadastrado com este telefone.");
      }
      throw erro;
    }
  }

  private ehErroDeTelefoneDuplicado(erro: unknown): boolean {
    if (typeof erro !== "object" || erro === null || !("code" in erro) || (erro as { code: unknown }).code !== 11000) {
      return false;
    }
    const keyPattern = (erro as { keyPattern?: Record<string, unknown> }).keyPattern;
    if (keyPattern) return "telefoneNormalizado" in keyPattern;
    const mensagem = String((erro as { message?: unknown }).message ?? "");
    return mensagem.includes("telefoneNormalizado");
  }

  async encontrarPorId(id: string): Promise<ClienteDocument | null> {
    if (!isValidObjectId(id)) return null;
    return this.clienteModel.findOne({ _id: id, excluidoEm: null }).exec();
  }

  async encontrarPorIdOuFalhar(id: string): Promise<ClienteDocument> {
    const cliente = await this.encontrarPorId(id);
    if (!cliente) throw ApiException.notFound("Cliente não encontrado.");
    return cliente;
  }

  /** Base da checagem de telefone duplicado — ignora o próprio registro em atualizações. */
  async encontrarPorTelefoneNormalizado(telefoneNormalizado: string, ignorarId?: string): Promise<ClienteDocument | null> {
    const filtro: Record<string, unknown> = { telefoneNormalizado, excluidoEm: null };
    if (ignorarId) filtro["_id"] = { $ne: ignorarId };
    return this.clienteModel.findOne(filtro).exec();
  }

  /** Todos os clientes ativos, sem paginação — usado por agregações cross-módulo (ex.: Dashboard). */
  async encontrarTodosAtivos(): Promise<ClienteDocument[]> {
    return this.clienteModel.find({ excluidoEm: null }).exec();
  }

  /**
   * Mesmo padrão de concorrência de Produtos: aplica `mutar` e salva com o
   * versionamento otimista do Mongoose (`__v`); se outra requisição alterou o
   * documento entre a leitura e a gravação, `save()` rejeita com
   * `VersionError` e a operação é refeita do zero.
   */
  async salvarComRetentativa(id: string, mutar: (cliente: ClienteDocument) => void, tentativas = 3): Promise<ClienteDocument> {
    for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
      const cliente = await this.encontrarPorIdOuFalhar(id);
      mutar(cliente);
      try {
        return await cliente.save();
      } catch (erro) {
        if (!(erro instanceof MongooseErrors.VersionError) || tentativa === tentativas) throw erro;
      }
    }
    // Inatingível: o loop sempre retorna ou lança na última tentativa.
    throw ApiException.conflict(
      "Não foi possível salvar as alterações: o cliente foi modificado por outra operação simultânea. Tente novamente.",
    );
  }

  async listarComFacetas(params: ListarClientesParams): Promise<ListaClientesResultado> {
    const base = filtroSempreAtivo(params.busca);
    const filtroCompleto = combinarFiltros(base, params.selecao);
    const direcao = params.ordem === "desc" ? -1 : 1;
    const skip = (params.page - 1) * params.limit;

    /** Um sub-facet por VALOR (não por grupo): os valores de historico/aniversario/recencia não são mutuamente exclusivos, então não dá para agrupar num único `$group` como em Produtos (estoque/promoção são binários e exclusivos). */
    const subFacetValor = (chave: ChaveFacetaCliente, valor: string): PipelineStage[] => {
      const baseGrupo = combinarFiltros(base, params.selecao, chave);
      const condicaoValor = condicaoFaceta(chave, [valor]) ?? {};
      return [{ $match: { $and: [baseGrupo, condicaoValor] } }, { $count: "valor" }];
    };

    const subFacetsPorGrupo = (chave: ChaveFacetaCliente, valores: readonly string[]): Record<string, PipelineStage[]> =>
      Object.fromEntries(valores.map((valor) => [`${chave}__${valor}`, subFacetValor(chave, valor)]));

    const pipeline: PipelineStage[] = [
      {
        $facet: {
          ...subFacetsPorGrupo(FACETAS_CLIENTE.recencia, JANELAS_RECENCIA),
          ...subFacetsPorGrupo(FACETAS_CLIENTE.historico, VALORES_HISTORICO),
          ...subFacetsPorGrupo(FACETAS_CLIENTE.aniversario, VALORES_ANIVERSARIO),
          ...subFacetsPorGrupo(FACETAS_CLIENTE.observacao, VALORES_OBSERVACAO),
          total: [{ $match: filtroCompleto }, { $count: "valor" }],
          pagina: [{ $match: filtroCompleto }, { $sort: { [params.ordenarPor]: direcao } }, { $skip: skip }, { $limit: params.limit }],
        },
      },
    ];

    const [resultado] = (await this.clienteModel.aggregate(pipeline).exec()) as ResultadoAggregate[];
    const total = contarValor(resultado, "total");

    // Hidrata os documentos da página como instâncias reais do Model (para o
    // `toJSON` do schema — `_id`→`id`, campos ocultos — ser aplicado normalmente).
    const itens = (resultado?.pagina ?? []).map((doc) => this.clienteModel.hydrate(doc));

    const facets: ApiFacets = {
      [FACETAS_CLIENTE.recencia]: JANELAS_RECENCIA.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_CLIENTE.recencia}__${valor}`),
      })),
      [FACETAS_CLIENTE.historico]: VALORES_HISTORICO.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_CLIENTE.historico}__${valor}`),
      })),
      [FACETAS_CLIENTE.aniversario]: VALORES_ANIVERSARIO.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_CLIENTE.aniversario}__${valor}`),
      })),
      [FACETAS_CLIENTE.observacao]: VALORES_OBSERVACAO.map((valor) => ({
        valor,
        count: contarValor(resultado, `${FACETAS_CLIENTE.observacao}__${valor}`),
      })),
    };

    return { itens, total, facets };
  }
}

function contarValor(resultado: ResultadoAggregate | undefined, chave: string): number {
  const grupo = resultado?.[chave] as { valor: number }[] | undefined;
  return grupo?.[0]?.valor ?? 0;
}
