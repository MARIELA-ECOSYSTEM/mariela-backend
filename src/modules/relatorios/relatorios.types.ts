/** Espelha `RelatorioSerie`/`ResumoRelatorios` (`src/types/relatorio.ts` do Backoffice). */
export interface RelatorioSerie {
  label: string;
  valor: number;
}

export interface ResumoRelatorios {
  demonstracao: boolean;
  geradoEm: string;
  totalProdutos: number;
  totalVariantes: number;
  pecasEmEstoque: number;
  produtosSemEstoque: number;
  valorCustoEstoque: number;
  valorVendaEstoque: number;
  margemMediaPercentual: number;
  produtosPorCategoria: RelatorioSerie[];
  pecasPorCategoria: RelatorioSerie[];
  topEstoque: RelatorioSerie[];
  cadastrosPorMes: RelatorioSerie[];
}
