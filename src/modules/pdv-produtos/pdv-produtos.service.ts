import { Injectable } from "@nestjs/common";
import type { Types } from "mongoose";
import type { ApiMeta } from "../../common/types/api-response.interface.js";
import type { ListarProdutosQueryDto } from "../produtos/dto/listar-produtos-query.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { ProdutoDocument } from "../produtos/schemas/produto.schema.js";
import type { Tamanho } from "../produtos/schemas/tamanho.schema.js";
import type { Variante } from "../produtos/schemas/variante.schema.js";
import { precoEfetivo } from "../produtos/utils/precos.util.js";
import type { ListarProdutosPdvQueryDto } from "./dto/listar-produtos-pdv-query.dto.js";
import type { ProdutoCatalogoPdv, TamanhoCatalogoPdv, VarianteCatalogoPdv } from "./pdv-produtos.types.js";

export interface ResultadoCatalogoPdv {
  data: ProdutoCatalogoPdv[];
  meta: ApiMeta;
}

/** Elemento de `Produto.variantes`/`Variante.tamanhos` (`Types.DocumentArray`) — subdocumento com `_id`, sem os demais campos de `Document` que `HydratedDocument` exigiria. */
type SubdocumentoComId<T> = T & { _id: Types.ObjectId };

/**
 * Camada de ADAPTAÇÃO/ORQUESTRAÇÃO entre o MARIELA PDV e o domínio de
 * Produtos — NÃO é uma segunda implementação. Toda regra (busca, paginação,
 * ordenação, preço efetivo, cálculo de estoque, exclusão) continua
 * inteiramente em `ProdutosService`/`ProdutosRepository`/`precos.util.ts`;
 * este service só delega e projeta o resultado para o formato de venda do
 * PDV (`ProdutoCatalogoPdv`), removendo campos administrativos.
 */
@Injectable()
export class PdvProdutosService {
  constructor(private readonly produtosService: ProdutosService) {}

  async listar(query: ListarProdutosPdvQueryDto): Promise<ResultadoCatalogoPdv> {
    // Mapeia para o DTO administrativo completo (facetas sempre vazias — o
    // catálogo do PDV não expõe filtro organizacional, ver o DTO do PDV) e
    // delega inteiramente a `ProdutosService.listar`, a MESMA busca/paginação/
    // ordenação já usada pelo Backoffice — nunca uma segunda implementação.
    const queryAdmin: ListarProdutosQueryDto = {
      busca: query.busca,
      ordenarPor: query.ordenarPor,
      ordem: query.ordem,
      categorias: [],
      colecoes: [],
      campanhas: [],
      fornecedores: [],
      estoque: [],
      promocao: [],
      novidade: [],
      page: query.page,
      limit: query.limit,
    };

    const { data, meta } = await this.produtosService.listar(queryAdmin);
    return { data: data.map((produto) => this.paraCatalogoPdv(produto)), meta };
  }

  /** Busca DIRETA por id (`ProdutosService.obterPorId` → `encontrarPorIdOuFalhar`) — nunca lista+filtra em memória. Produto excluído já lança 404 (mesmo padrão do Backoffice). */
  async obterPorId(id: string): Promise<ProdutoCatalogoPdv> {
    const produto = await this.produtosService.obterPorId(id);
    return this.paraCatalogoPdv(produto);
  }

  private paraCatalogoPdv(produto: ProdutoDocument): ProdutoCatalogoPdv {
    return {
      id: produto.id,
      codProduto: produto.codProduto,
      nome: produto.nome,
      descricao: produto.descricao,
      categoria: produto.categoria,
      imagem: this.imagemPrincipal(produto),
      precoVenda: produto.precoVenda,
      precoPromocional: produto.precoPromocional,
      precoEfetivo: precoEfetivo(produto),
      ehPromocao: produto.ehPromocao,
      quantidadeTotal: produto.quantidadeTotal,
      disponivel: produto.quantidadeTotal > 0,
      variantes: produto.variantes.map((variante) => this.paraVarianteCatalogo(variante)),
    };
  }

  private paraVarianteCatalogo(variante: SubdocumentoComId<Variante>): VarianteCatalogoPdv {
    return {
      id: String(variante._id),
      cor: variante.cor,
      foto: variante.foto,
      quantidade: variante.quantidadeVariante,
      disponivel: variante.quantidadeVariante > 0,
      tamanhos: variante.tamanhos.map(
        (tamanho: SubdocumentoComId<Tamanho>): TamanhoCatalogoPdv => ({
          id: String(tamanho._id),
          tamanho: tamanho.tamanho,
          quantidade: tamanho.quantidade,
          disponivel: tamanho.quantidade > 0,
        }),
      ),
    };
  }

  /**
   * Mesma regra de `fotosDoProduto` (`src/utils/produto.ts`, frontend): a
   * imagem principal é a variante marcada em `fotoPrincipalVarianteId`; sem
   * marcação (ou se a variante marcada não tiver foto), vale a primeira foto
   * cadastrada. Nunca duplicar esta decisão de forma divergente.
   */
  private imagemPrincipal(produto: ProdutoDocument): string | null {
    const comFoto = produto.variantes.filter((variante) => Boolean(variante.foto));
    if (comFoto.length === 0) return null;
    const principalId = produto.fotoPrincipalVarianteId ? String(produto.fotoPrincipalVarianteId) : null;
    const principal = comFoto.find((variante) => String(variante._id) === principalId);
    return (principal ?? comFoto[0])!.foto;
  }
}
