import type { StatusVenda } from "../vendas/vendas.constants.js";
import type { OrigemMovimentacao, SentidoMovimentacao, TipoMovimentacaoCaixa } from "./caixas.constants.js";

/** Formato de entrada do repository — deliberadamente não reusa a classe `@Schema`. */
export interface DadosCriarCaixa {
  codigo: string;
  status: "aberto";
  valorInicial: number;
  dataAbertura: Date;
  observacaoAbertura: string;
  dataFechamento: null;
  valorInformado: null;
  valorEsperado: null;
  diferenca: null;
  observacaoFechamento: "";
}

export interface DadosFecharCaixa {
  dataFechamento: Date;
  valorInformado: number;
  valorEsperado: number;
  diferenca: number;
  observacaoFechamento: string;
}

export interface DadosCriarMovimento {
  caixaId: string;
  dataHora: Date;
  tipo: TipoMovimentacaoCaixa;
  origem: OrigemMovimentacao;
  descricao: string;
  referencia: string | null;
  vendaId: string | null;
  vendaCodigo: string | null;
  formaPagamento: string;
  valor: number;
  sentido: SentidoMovimentacao;
  observacao: string;
  motivo: string | null;
  idempotencyKey: string | null;
}

/**
 * Etapa 18.2 — saldo sem limite inferior de zero: `saldoEsperado` pode ser
 * negativo (sangria/cancelamento sem cobertura de saldo é uma decisão de
 * negócio permitida, não um erro). `totalVendas`/`recebimentos` são mantidos
 * no formato já consumido pelo Backoffice (`ResumoCaixa`), mas
 * `recebimentos` é sempre `0`: o conceito de "recebimento de parcela"
 * separado de "venda" não existe mais no novo domínio — toda entrada de
 * venda (à vista ou baixa de parcela) é só `totalVendas` agora.
 */
export interface ResumoCaixaCalculado {
  valorAbertura: number;
  totalVendas: number;
  recebimentos: number;
  entradasManuais: number;
  totalEntradas: number;
  saidasManuais: number;
  devolucoes: number;
  totalSaidas: number;
  /** Saldo de TODAS as formas de pagamento (abertura + entradas − saídas). Usado em listas, filtros e ordenação. */
  saldoEsperado: number;
  quantidadeVendas: number;
  quantidadeMovimentacoes: number;
  /**
   * Fase 22.8.9.12 — dinheiro FÍSICO esperado na gaveta: abertura + movimentos em "Dinheiro" (ver `gaveta.util.ts`).
   * É a base do `valorEsperado`/`diferenca` dos fechamentos a partir desta fase.
   */
  dinheiroEsperado: number;
  /** Fase 22.8.9.12 — totais informativos por forma de pagamento; não entram no `dinheiroEsperado`. */
  porFormaPagamento: ResumoFormaPagamentoCaixa[];
}

export interface ResumoFormaPagamentoCaixa {
  /** Nome da forma como registrada no movimento. */
  forma: string;
  /** `true` só para "Dinheiro": a única forma que movimenta a gaveta. */
  dinheiroFisico: boolean;
  entradas: number;
  saidas: number;
  /** `entradas − saidas`. */
  saldo: number;
}

/**
 * Etapa 18.2 — projeção de uma `Venda` para `GET /caixas/:id` (campo
 * `vendas`) — espelha `VendaResumo` do Backoffice exatamente, mesmo formato
 * já usado por `VendaResumoDoCliente`/`VendaResumoDoVendedor`. O Caixa
 * apenas CONSULTA a Venda (autoridade comercial) — nunca duplica/recalcula
 * nada dela.
 */
export interface VendaResumoDoCaixa {
  id: string;
  codigo: string;
  numero: string;
  dataVenda: Date;
  clienteId: string | null;
  clienteNome: string;
  vendedorId: string;
  vendedorNome: string;
  caixaId: string | null;
  caixaCodigo: string | null;
  totalItens: number;
  valorBruto: number;
  descontoPromocional: number;
  descontoVenda: number;
  descontoTotal: number;
  valorFinal: number;
  valorPago: number;
  valorPendente: number;
  valorDevolvido: number;
  temPromocao: boolean;
  temDesconto: boolean;
  formaPagamento: string;
  totalParcelas: number;
  parcelasPagas: number;
  status: StatusVenda;
}
