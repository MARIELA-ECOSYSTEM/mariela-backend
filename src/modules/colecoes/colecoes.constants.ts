/**
 * Grupos de facetas de Coleções — mesmo esquema de seleção múltipla (CSV) já
 * usado por Produtos/Clientes/Fornecedores, aplicado aos filtros que a tela
 * de Coleções já expõe (`src/routes/_backoffice/colecoes/index.tsx`).
 */
export const FACETAS_COLECAO = {
  situacao: "situacao",
  destaque: "destaque",
  banner: "banner",
  produtos: "produtos",
} as const;

export type ChaveFacetaColecao = (typeof FACETAS_COLECAO)[keyof typeof FACETAS_COLECAO];

/** Situação derivada de `inicio`/`fim`/`ativo` — mesma regra de `utils/vitrine.ts#statusVigencia` no frontend. */
export const VALORES_SITUACAO = ["ativa", "agendada", "encerrada", "inativa"] as const;
export type ValorSituacao = (typeof VALORES_SITUACAO)[number];

export const VALORES_DESTAQUE = ["sim", "nao"] as const;
export const VALORES_BANNER = ["sim", "nao"] as const;
export const VALORES_PRODUTOS = ["com", "sem"] as const;

export const PREFIXO_CODIGO_COLECAO = "COL";
export const CHAVE_SEQUENCIA_COLECAO = "colecao";
export const DIGITOS_CODIGO_COLECAO = 4;

export const PAGINA_PADRAO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;

export type OrdenarColecaoPor = "nome" | "criadoEm" | "inicio" | "fim";
export type Ordem = "asc" | "desc";
