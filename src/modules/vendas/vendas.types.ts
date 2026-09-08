import type { ModalidadeTarifa } from "../adquirentes/adquirentes.constants.js";
import type { ModalidadePagamento, TipoDesconto } from "./vendas.constants.js";

/**
 * Snapshot histórico da tarifa efetivamente aplicada a um pagamento
 * débito/crédito no momento da venda (Etapa 10.5) — NUNCA recalculado depois.
 * Se a tabela de tarifas do adquirente mudar amanhã, esta venda continua
 * preservando o percentual/valores vigentes quando ela foi criada (mesmo
 * princípio de snapshot já usado em `ItemVenda`). `modalidade` aqui é
 * `ModalidadeTarifa` (só "debito"/"credito") — nunca "dinheiro"/"pix", que
 * nunca têm `tarifaAplicada` (sempre `null`).
 */
export interface TarifaAplicada {
  adquirenteId: string;
  adquirenteNome: string;
  modalidade: ModalidadeTarifa;
  parcelas: number;
  percentual: number;
  valorBruto: number;
  valorTarifa: number;
  valorLiquido: number;
}

/**
 * Formato compartilhado de desconto — usado tanto para o desconto de um item
 * quanto para o desconto da venda. Representa a INTENÇÃO solicitada (um
 * percentual ou um valor absoluto); o backend sempre resolve essa intenção
 * para um valor monetário concreto antes de persistir — o percentual NUNCA é
 * a autoridade do valor final (ver `VendasService.resolverDesconto`).
 */
export interface Desconto {
  tipo: TipoDesconto;
  valor: number;
}

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
  /** Desconto sobre o preço PRATICADO desta linha (após promoção) — nunca sobre o preço de tabela. Opcional. */
  desconto?: Desconto;
}

/**
 * `modalidade`/`adquirenteId` são ADITIVOS (Etapa 10.4) e opcionais — um
 * pagamento legado sem eles continua funcionando exatamente como antes
 * (`forma` livre, sem nenhuma das novas validações). Quando `modalidade` é
 * informada, ela — nunca `forma` — é a autoridade para as regras de
 * adquirente/parcelamento (ver `VendasService.validarPagamentoEstruturado`).
 */
export interface PagamentoSolicitado {
  forma: string;
  valor: number;
  parcelas?: number;
  observacao?: string;
  modalidade?: ModalidadePagamento;
  adquirenteId?: string;
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
  /**
   * Desconto concedido pelo operador sobre o subtotal da venda (já com os
   * descontos de item aplicados) — validado contra esse subtotal. Um
   * `number` puro é retrocompatível: interpretado como `{tipo:"valor", valor}`
   * (mesmo contrato que este campo sempre teve antes desta etapa).
   */
  descontoVenda?: number | Desconto;
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
