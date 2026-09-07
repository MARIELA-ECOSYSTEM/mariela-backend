export const STATUS_CAIXA = ["aberto", "fechado"] as const;
export type CaixaStatus = (typeof STATUS_CAIXA)[number];

/**
 * Só `entrada`/`saida` são criáveis por qualquer endpoint deste módulo hoje.
 * `venda`/`recebimento_parcela`/`devolucao`/`cancelamento` existem no enum
 * porque já fazem parte do contrato consumido pelo Backoffico
 * (`src/types/caixa.ts`) e serão escritos pelo futuro módulo de Vendas — mas
 * nenhuma rota aqui aceita `tipo` vindo do cliente para esses valores.
 */
export const TIPOS_MOVIMENTACAO = [
  "venda",
  "recebimento_parcela",
  "entrada",
  "saida",
  "devolucao",
  "cancelamento",
] as const;
export type TipoMovimentacaoCaixa = (typeof TIPOS_MOVIMENTACAO)[number];

export const ORIGENS_MOVIMENTACAO = ["venda", "parcela", "manual", "devolucao", "cancelamento"] as const;
export type OrigemMovimentacao = (typeof ORIGENS_MOVIMENTACAO)[number];

export const SENTIDOS_MOVIMENTACAO = ["entrada", "saida"] as const;
export type SentidoMovimentacao = (typeof SENTIDOS_MOVIMENTACAO)[number];

/** Sentido financeiro de cada tipo — mesma tabela de `src/utils/caixa.ts#SENTIDO_MOVIMENTACAO`. */
export const SENTIDO_POR_TIPO: Record<TipoMovimentacaoCaixa, SentidoMovimentacao> = {
  venda: "entrada",
  recebimento_parcela: "entrada",
  entrada: "entrada",
  saida: "saida",
  devolucao: "saida",
  cancelamento: "saida",
};

export const PREFIXO_CODIGO_CAIXA = "CAIXA";
export const CHAVE_SEQUENCIA_CAIXA = "caixa";
export const DIGITOS_CODIGO_CAIXA = 4;

export const PAGINA_PADRAO = 1;
export const LIMITE_PADRAO = 20;
export const LIMITE_MAXIMO = 100;

/** Movimentos têm volume potencialmente maior por caixa (dezenas por dia) — limite um pouco mais generoso. */
export const PAGINA_PADRAO_MOVIMENTOS = 1;
export const LIMITE_PADRAO_MOVIMENTOS = 50;
export const LIMITE_MAXIMO_MOVIMENTOS = 200;

/** Quantidade de movimentações recentes embutidas em `GET /caixas/:id` (histórico completo é `GET /caixas/:id/movimentacoes`). */
export const MOVIMENTOS_RECENTES_NO_DETALHE = 20;

export type OrdenarCaixaPor = "data" | "faturamento" | "saldo" | "diferenca" | "vendas";
export type Ordem = "asc" | "desc";

export const FACETAS_CAIXA = {
  status: "status",
  periodo: "periodo",
  responsavel: "responsavel",
  diferenca: "diferenca",
  saldo: "saldo",
} as const;
export type ChaveFacetaCaixa = (typeof FACETAS_CAIXA)[keyof typeof FACETAS_CAIXA];

export const VALORES_PERIODO = ["hoje", "7d", "30d", "mes", "mes-anterior"] as const;
export type ValorPeriodo = (typeof VALORES_PERIODO)[number];

export const VALORES_DIFERENCA = ["conferido", "sobra", "falta"] as const;
export type ValorDiferenca = (typeof VALORES_DIFERENCA)[number];

/** Mesmas faixas de `FAIXAS_SALDO_CAIXA` no frontend (`src/utils/caixa.ts`). */
export const FAIXAS_SALDO: { valor: string; min: number; max: number }[] = [
  { valor: "ate-500", min: 0, max: 500 },
  { valor: "500-1500", min: 500, max: 1500 },
  { valor: "1500-3000", min: 1500, max: 3000 },
  { valor: "acima-3000", min: 3000, max: Number.POSITIVE_INFINITY },
];

export const DIFERENCA_TOLERANCIA = 0.005;
