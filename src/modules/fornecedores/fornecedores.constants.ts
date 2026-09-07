/**
 * Grupos de facetas de Fornecedores — mesmo esquema de seleção múltipla (CSV)
 * já usado por Produtos/Clientes, aplicado aos filtros que a tela de
 * Fornecedores já expõe (`src/routes/_backoffice/fornecedores.tsx`).
 */
export const FACETAS_FORNECEDOR = {
  produtos: "produtos",
  endereco: "endereco",
  entrada: "entrada",
  documento: "documento",
} as const;

export type ChaveFacetaFornecedor = (typeof FACETAS_FORNECEDOR)[keyof typeof FACETAS_FORNECEDOR];

/** Faixas de produtos vinculados — mesmos valores de `OPCOES_FAIXA_PRODUTOS` no frontend. */
export const FAIXAS_PRODUTOS = ["sem", "1-5", "6-15", "16+"] as const;
export type FaixaProdutos = (typeof FAIXAS_PRODUTOS)[number];

export const VALORES_ENDERECO = ["com", "sem"] as const;
export type ValorEndereco = (typeof VALORES_ENDERECO)[number];

/** Janelas de recência de entrada, em DIAS — mesmos valores de `OPCOES_FAIXA_PRODUTOS`-like no frontend. */
export const JANELAS_ENTRADA = ["30", "90", "nunca"] as const;
export type JanelaEntrada = (typeof JANELAS_ENTRADA)[number];

export const VALORES_DOCUMENTO = ["com", "sem"] as const;
export type ValorDocumento = (typeof VALORES_DOCUMENTO)[number];

export const PREFIXO_CODIGO_FORNECEDOR = "FOR";
export const CHAVE_SEQUENCIA_FORNECEDOR = "fornecedor";
export const DIGITOS_CODIGO_FORNECEDOR = 4;

export const PAGINA_PADRAO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;

export type OrdenarFornecedorPor = "nome" | "produtosVinculados" | "valorEmCusto" | "ultimaEntrada" | "criadoEm";
export type Ordem = "asc" | "desc";
