/**
 * Fórmula canônica de faturamento (Fase 29A/29B.1) — fonte única reutilizada
 * por `VendasService.estatisticas` e `DashboardService.resumo`, para as duas
 * NUNCA MAIS divergirem sobre o que "faturamento" significa:
 *
 *   faturamentoBruto   = Σ valorFinal
 *   faturamentoLiquido = Σ (valorFinal - valorDevolvido)
 *
 * Vendas `cancelada` nunca entram em nenhum dos dois (excluídas aqui dentro —
 * o chamador não precisa filtrar antes). `valorDevolvido` ausente/null/negativo
 * é tratado como zero; a contribuição líquida de uma venda nunca fica negativa
 * por causa de uma inconsistência pontual de dados (ex.: devolvido > final).
 */
import { arredondarMoeda } from "../produtos/utils/precos.util.js";

export interface VendaParaFaturamento {
  status: string;
  valorFinal: number;
  valorDevolvido?: number | null;
}

export interface FaturamentoResultado {
  faturamentoBruto: number;
  faturamentoLiquido: number;
}

export function calcularFaturamento(vendas: VendaParaFaturamento[]): FaturamentoResultado {
  let bruto = 0;
  let liquido = 0;

  for (const venda of vendas) {
    if (venda.status === "cancelada") continue;
    const valorDevolvido = Math.max(0, venda.valorDevolvido ?? 0);
    bruto += venda.valorFinal;
    liquido += Math.max(0, venda.valorFinal - valorDevolvido);
  }

  return {
    faturamentoBruto: arredondarMoeda(bruto),
    faturamentoLiquido: arredondarMoeda(liquido),
  };
}
