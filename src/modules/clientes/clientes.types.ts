import type { StatusVenda } from "../vendas/vendas.constants.js";

/** Formato de entrada do repository — deliberadamente não reusa a classe `@Schema`. */
export interface DadosCriarCliente {
  codigo: string;
  nome: string;
  foto: string | null;
  telefone: string;
  telefoneNormalizado: string;
  dataNascimento: Date | null;
  observacao: string;
  compras: number;
  totalComprado: number;
  ultimaCompra: Date | null;
  excluidoEm: null;
}

/**
 * Projeção de uma `Venda` para `GET /clientes/:id/vendas` (Etapa 13.2) —
 * espelha `VendaResumo` do Backoffice (`src/types/venda.ts`) EXATAMENTE:
 * mesmos campos de `VendaDetalhe` MENOS `itens`/`pagamentos`/`parcelas`/
 * `historico`/`observacao`/`cancelamento` (detalhe pesado, não faz parte do
 * "resumo" de histórico) e menos os campos puramente internos do backend
 * (`idempotencyKey`, `criadoEm`, `atualizadoEm`) — nunca vazados aqui.
 */
export interface VendaResumoDoCliente {
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
