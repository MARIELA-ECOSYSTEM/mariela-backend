export const STATUS_CAIXA = ["aberto", "fechado"] as const;
export type CaixaStatus = (typeof STATUS_CAIXA)[number];

/**
 * Etapa 18.2 — domínio simplificado: o Caixa é o CAIXA GERAL DA LOJA, não um
 * caixa por vendedor. Existem exatamente 4 tipos de movimento financeiro,
 * substituindo os 6 antigos (`venda`/`recebimento_parcela`/`entrada`/`saida`/
 * `devolucao`/`cancelamento`):
 *
 * - `injecao` (era `entrada`): entrada manual (suprimento/ajuste).
 * - `sangria` (era `saida`): saída manual (retirada/despesa).
 * - `venda` (era `venda` + `recebimento_parcela`): QUALQUER impacto financeiro
 *   positivo de uma venda — à vista OU baixa de parcela — o Caixa não
 *   distingue mais os dois casos, só conhece "entrou dinheiro desta venda".
 * - `cancelamento` (era `cancelamento` + `devolucao`): QUALQUER impacto
 *   financeiro negativo de cancelamento/devolução de uma venda — total ou
 *   parcial, o Caixa não distingue, só conhece "saiu dinheiro desta venda".
 *
 * Só `injecao`/`sangria` são criáveis pelas rotas manuais deste módulo
 * (`POST /:id/entrada`, `POST /:id/saida` — URLs preservadas por
 * compatibilidade com o Backoffice, mas o `tipo` persistido já é o novo).
 * `venda`/`cancelamento` só nascem via `CaixasService.registrarMovimentoDeVenda`,
 * chamado exclusivamente por `VendasService` — nenhuma rota HTTP aceita
 * `tipo` como valor livre do cliente.
 */
export const TIPOS_MOVIMENTACAO = ["injecao", "sangria", "venda", "cancelamento"] as const;
export type TipoMovimentacaoCaixa = (typeof TIPOS_MOVIMENTACAO)[number];

/** Origem operacional do lançamento — só para exibição/filtro, nunca escolhida livremente pelo cliente em `venda`/`cancelamento`. */
export const ORIGENS_MOVIMENTACAO = ["manual", "venda", "cancelamento"] as const;
export type OrigemMovimentacao = (typeof ORIGENS_MOVIMENTACAO)[number];

export const SENTIDOS_MOVIMENTACAO = ["entrada", "saida"] as const;
export type SentidoMovimentacao = (typeof SENTIDOS_MOVIMENTACAO)[number];

/** Sentido financeiro de cada tipo — agora uma correspondência 1:1 (era uma tabela de 6 valores). */
export const SENTIDO_POR_TIPO: Record<TipoMovimentacaoCaixa, SentidoMovimentacao> = {
  injecao: "entrada",
  venda: "entrada",
  sangria: "saida",
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

/**
 * Etapa 18.2 — o grupo de faceta "responsavel" foi removido: o Caixa não tem
 * mais vínculo de vendedor/responsável (ver `caixas.service.ts`). Os grupos
 * restantes são inalterados.
 */
export const FACETAS_CAIXA = {
  status: "status",
  periodo: "periodo",
  diferenca: "diferenca",
  saldo: "saldo",
} as const;
export type ChaveFacetaCaixa = (typeof FACETAS_CAIXA)[keyof typeof FACETAS_CAIXA];

export const VALORES_PERIODO = ["hoje", "7d", "30d", "mes", "mes-anterior"] as const;
export type ValorPeriodo = (typeof VALORES_PERIODO)[number];

export const VALORES_DIFERENCA = ["conferido", "sobra", "falta"] as const;
export type ValorDiferenca = (typeof VALORES_DIFERENCA)[number];

/** Mesmas faixas de `FAIXAS_SALDO_CAIXA` no frontend (`src/utils/caixa.ts`) — agora incluindo faixas negativas, já que o saldo pode ser negativo. */
export const FAIXAS_SALDO: { valor: string; min: number; max: number }[] = [
  { valor: "negativo", min: Number.NEGATIVE_INFINITY, max: 0 },
  { valor: "ate-500", min: 0, max: 500 },
  { valor: "500-1500", min: 500, max: 1500 },
  { valor: "1500-3000", min: 1500, max: 3000 },
  { valor: "acima-3000", min: 3000, max: Number.POSITIVE_INFINITY },
];

export const DIFERENCA_TOLERANCIA = 0.005;
