/**
 * Grupos de facetas de Clientes — mesmo esquema de seleção múltipla (CSV) já
 * usado por Produtos, aplicado aos filtros que a tela de Clientes já expõe
 * (`src/routes/_backoffice/clientes.tsx`): recência de compra, histórico de
 * compras, aniversário e presença de observação.
 */
export const FACETAS_CLIENTE = {
  recencia: "recencia",
  historico: "historico",
  aniversario: "aniversario",
  observacao: "observacao",
} as const;

export type ChaveFacetaCliente = (typeof FACETAS_CLIENTE)[keyof typeof FACETAS_CLIENTE];

/** Janelas de "sem compra recente" — mesmos valores de `OPCOES_SEM_COMPRA` no frontend. */
export const JANELAS_RECENCIA = ["1m", "3m", "6m"] as const;
export type JanelaRecencia = (typeof JANELAS_RECENCIA)[number];

export const VALORES_HISTORICO = ["com", "sem", "recorrente"] as const;
export type ValorHistorico = (typeof VALORES_HISTORICO)[number];

export const VALORES_ANIVERSARIO = ["mes", "semana", "com", "sem"] as const;
export type ValorAniversario = (typeof VALORES_ANIVERSARIO)[number];

export const VALORES_OBSERVACAO = ["com", "sem"] as const;
export type ValorObservacao = (typeof VALORES_OBSERVACAO)[number];

export const PREFIXO_CODIGO_CLIENTE = "CLI";
export const CHAVE_SEQUENCIA_CLIENTE = "cliente";
export const DIGITOS_CODIGO_CLIENTE = 4;

export const PAGINA_PADRAO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;

export type OrdenarClientePor = "nome" | "compras" | "totalComprado" | "ultimaCompra" | "criadoEm";
export type Ordem = "asc" | "desc";

/** Quantidade de dígitos válida para um telefone brasileiro com DDD (fixo ou celular). */
export const TELEFONE_DIGITOS_VALIDOS = [10, 11];
