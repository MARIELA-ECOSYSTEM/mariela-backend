import { MODALIDADES_TARIFA } from "../adquirentes/adquirentes.constants.js";

/**
 * EM_PAGAMENTO → estoque já baixado, valor pendente > 0.
 * CONCLUIDA    → valor pendente = 0.
 * CANCELADA    → cancelada integralmente (ou devolução parcial que zerou os itens).
 */
export const STATUS_VENDA = ["em_pagamento", "concluida", "cancelada"] as const;
export type StatusVenda = (typeof STATUS_VENDA)[number];

/**
 * Modalidade estruturada de pagamento (Etapa 10.4) — "dinheiro"/"pix" nunca
 * têm adquirente; "debito"/"credito" sempre têm. Composta a partir de
 * `MODALIDADES_TARIFA` (`modules/adquirentes/adquirentes.constants.ts`) em
 * vez de redeclarar "debito"/"credito" aqui: essas duas strings são a MESMA
 * autoridade que decide se um pagamento exige adquirente/tarifa configurada
 * — nunca duas listas divergentes.
 */
export const MODALIDADES_PAGAMENTO = ["dinheiro", "pix", ...MODALIDADES_TARIFA] as const;
export type ModalidadePagamento = (typeof MODALIDADES_PAGAMENTO)[number];

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

/**
 * Fase 60.4.3.4.18 — estado PERSISTIDO da restauração de estoque de cada linha de um evento de cancelamento/devolução
 * (`Venda.cancelamentos[].itens[].estadoRestauracao`):
 *   - `pendente`: ainda não houve tentativa confirmada (estado inicial de toda linha nova);
 *   - `falha_recuperavel`: a última tentativa falhou e será repetida a partir de `proximaTentativaEm`;
 *   - `requer_intervencao`: excedeu o limite de tentativas — o worker não a repete; só um operador (rota ADMIN de
 *     reconciliação) a reabre;
 *   - `concluida`: estoque, ledger e marcação confirmados na MESMA transação.
 * Fonte de verdade de "concluída" continua sendo `restaurado === true` (compatível com eventos antigos, que só têm o
 * booleano). Ausência de `restaurado` NUNCA é tratada como concluída. Ver `restauracao-estoque.util.ts`.
 */
export const ESTADOS_RESTAURACAO = ["pendente", "falha_recuperavel", "requer_intervencao", "concluida"] as const;
export type EstadoRestauracao = (typeof ESTADOS_RESTAURACAO)[number];

/**
 * Fase 60.4.3.4.18 — parâmetros PADRÃO da reconciliação automática de estoque (sobrescrevíveis por ambiente, ver
 * `configuration.ts#reconciliacaoEstoque`). Espera entre tentativas = `base × 2^(tentativas−1)`, limitada a `maximo`.
 */
export const RECONCILIACAO_ESTOQUE_PADRAO = {
  intervaloMs: 60_000,
  loteVendas: 20,
  maxItensPorCiclo: 50,
  maxTentativas: 8,
  esperaBaseMs: 30_000,
  esperaMaximaMs: 3_600_000,
} as const;
