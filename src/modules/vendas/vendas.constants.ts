/**
 * EM_PAGAMENTO → estoque já baixado, valor pendente > 0.
 * CONCLUIDA    → valor pendente = 0.
 * CANCELADA    → cancelada integralmente (ou devolução parcial que zerou os itens).
 */
export const STATUS_VENDA = ["em_pagamento", "concluida", "cancelada"] as const;
export type StatusVenda = (typeof STATUS_VENDA)[number];

export const TIPOS_EVENTO_VENDA = ["criacao", "pagamento", "baixa_parcela", "devolucao", "cancelamento"] as const;
export type TipoEventoVenda = (typeof TIPOS_EVENTO_VENDA)[number];

/** Formato compartilhado de desconto (por item ou da venda) — a INTENÇÃO solicitada, nunca a autoridade do valor final (ver `Desconto` em `vendas.types.ts`). */
export const TIPOS_DESCONTO = ["percentual", "valor"] as const;
export type TipoDesconto = (typeof TIPOS_DESCONTO)[number];

export const PREFIXO_CODIGO_VENDA = "VENDA";
export const CHAVE_SEQUENCIA_VENDA = "venda";
export const DIGITOS_CODIGO_VENDA = 4;
export const DIGITOS_NUMERO_VENDA = 6;

export const PAGINA_PADRAO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;

export type OrdenarVendaPor = "data" | "valor" | "pendente";
export type Ordem = "asc" | "desc";

export const FACETAS_VENDA = {
  status: "status",
  periodo: "periodo",
  vendedor: "vendedor",
  cliente: "cliente",
  pagamento: "pagamento",
  caixa: "caixa",
  valor: "valor",
  condicoes: "condicoes",
  financeiro: "financeiro",
} as const;
export type ChaveFacetaVenda = (typeof FACETAS_VENDA)[keyof typeof FACETAS_VENDA];

export const VALORES_PERIODO = ["hoje", "7d", "30d", "mes", "mes-anterior"] as const;
export const VALORES_CONDICOES = ["promocao", "desconto", "cheio"] as const;
export const VALORES_FINANCEIRO = ["quitada", "pendente", "parcelada", "devolucao"] as const;

/** Mesmas faixas de `FAIXAS_VALOR_VENDA` no frontend (`src/utils/venda.ts`). */
export const FAIXAS_VALOR: { valor: string; min: number; max: number }[] = [
  { valor: "ate-200", min: 0, max: 200 },
  { valor: "200-500", min: 200, max: 500 },
  { valor: "500-1000", min: 500, max: 1000 },
  { valor: "acima-1000", min: 1000, max: Number.POSITIVE_INFINITY },
];

export const DIFERENCA_TOLERANCIA = 0.005;
