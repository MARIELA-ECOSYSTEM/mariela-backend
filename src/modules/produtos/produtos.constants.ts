/**
 * Grupos de facetas do catálogo — mesmo contrato já consumido pelo Backoffice
 * (`src/lib/filtros/produtos-facetas.ts`). Os filtros "simples" antigos
 * (categoria única, promocao sim/não…) foram aposentados a favor deste
 * esquema único (decisão de negócio já aprovada).
 */
export const FACETAS_PRODUTO = {
  categorias: "categorias",
  colecoes: "colecoes",
  campanhas: "campanhas",
  fornecedores: "fornecedores",
  estoque: "estoque",
  promocao: "promocao",
  novidade: "novidade",
} as const;

export type ChaveFaceta = (typeof FACETAS_PRODUTO)[keyof typeof FACETAS_PRODUTO];

export const COM_ESTOQUE = "com_estoque";
export const SEM_ESTOQUE = "sem_estoque";
export const EM_PROMOCAO = "promocao";
export const SEM_PROMOCAO = "sem_promocao";
export const EH_NOVIDADE = "novidade";
export const SEM_NOVIDADE = "sem_novidade";

export const PREFIXO_CODIGO_PRODUTO = "PROD";
export const CHAVE_SEQUENCIA_PRODUTO = "produto";
export const DIGITOS_CODIGO_PRODUTO = 4;

export const PAGINA_PADRAO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;

export type OrdenarProdutoPor = "nome" | "codProduto" | "precoVenda" | "quantidadeTotal" | "criadoEm";
export type Ordem = "asc" | "desc";
