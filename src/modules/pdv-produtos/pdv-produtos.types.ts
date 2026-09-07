/**
 * Projeção de LEITURA do PDV sobre `Produto` — nunca uma segunda entidade
 * persistida (não existe collection própria; ver `pdv-produtos.service.ts`).
 * Omite deliberadamente tudo que é administrativo/interno e irrelevante para
 * vender: `precoCusto`, `margemLucro`, `colecaoId`/`campanhaId`/`fornecedorId`
 * (vínculos administrativos), `ehNovidade`, `estoqueZeradoEm`,
 * `criadoEm`/`atualizadoEm`. `descricao` foi mantida por ser genuinamente
 * útil na hora da venda (material, corte etc.), não um dado administrativo.
 */
export interface TamanhoCatalogoPdv {
  id: string;
  tamanho: string;
  quantidade: number;
  disponivel: boolean;
}

export interface VarianteCatalogoPdv {
  id: string;
  cor: string;
  foto: string | null;
  quantidade: number;
  disponivel: boolean;
  tamanhos: TamanhoCatalogoPdv[];
}

export interface ProdutoCatalogoPdv {
  id: string;
  codProduto: string;
  nome: string;
  descricao: string;
  categoria: string;
  /** Foto principal (mesma regra de `fotosDoProduto` do frontend — ver `pdv-produtos.service.ts`). */
  imagem: string | null;
  precoVenda: number;
  precoPromocional: number | null;
  /** Sempre calculado via `precoEfetivo` (`modules/produtos/utils/precos.util.ts`) — nunca recalculado aqui. */
  precoEfetivo: number;
  ehPromocao: boolean;
  quantidadeTotal: number;
  /** `quantidadeTotal > 0` — um produto pode estar ativo (não excluído) e mesmo assim indisponível por falta de estoque. */
  disponivel: boolean;
  variantes: VarianteCatalogoPdv[];
}
