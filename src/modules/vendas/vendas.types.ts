/**
 * Item solicitado na criação interna de uma venda — o service resolve preço,
 * snapshot e baixa de estoque a partir de `produtoId`/`varianteId`/`tamanhoId`.
 * Nunca aceitar preço/subtotal enviados pelo chamador.
 */
export interface ItemVendaSolicitado {
  produtoId: string;
  varianteId: string;
  tamanhoId: string;
  quantidade: number;
}

export interface PagamentoSolicitado {
  forma: string;
  valor: number;
  parcelas?: number;
  observacao?: string;
}

/**
 * Entrada do único ponto de criação de venda (`VendasService.criar`) — NÃO
 * exposto por nenhuma rota HTTP nesta etapa (ver relatório): a criação
 * pertence ao futuro MARIELA PDV. Usado hoje apenas pelos testes de
 * integração, exatamente como pedido pela tarefa ("criar uma venda de teste
 * pelo mecanismo interno apropriado").
 */
export interface DadosCriarVenda {
  clienteId?: string | null;
  vendedorId: string;
  caixaId: string;
  itens: ItemVendaSolicitado[];
  /** Desconto concedido pelo operador — validado contra o subtotal, nunca recalculado a partir de outra regra. */
  descontoVenda?: number;
  /** Pagamentos recebidos NO MOMENTO da venda (pode ser parcial ou vazio). */
  pagamentos: PagamentoSolicitado[];
  /**
   * Quando informado, o valor pendente (se houver) é dividido nessa
   * quantidade de parcelas (estilo Crediário). Quando ausente e ainda assim
   * houver pendente, uma única parcela cobre o saldo inteiro — garante que
   * todo valor a receber seja sempre cobrável via `POST .../parcelas/:id/baixa`.
   */
  totalParcelas?: number;
  observacao?: string;
  idempotencyKey?: string;
}

/**
 * Formato de entrada de `VendasRepository.criar` — já com preços resolvidos,
 * estoque baixado e totais calculados pelo service. Deliberadamente não reusa
 * a classe `@Schema` (mesmo padrão dos demais módulos).
 */
export interface DadosPersistirVenda {
  codigo: string;
  numero: string;
  dataVenda: Date;
  clienteId: string | null;
  clienteNome: string;
  vendedorId: string;
  vendedorNome: string;
  caixaId: string | null;
  caixaCodigo: string | null;
  itens: unknown[];
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
  observacao: string;
  pagamentos: unknown[];
  parcelas: unknown[];
  historico: unknown[];
  cancelamento: null;
  status: "em_pagamento" | "concluida";
  idempotencyKey: string | null;
}
