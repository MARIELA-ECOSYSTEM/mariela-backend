/**
 * Espelha exatamente `src/types/dashboard.ts` do frontend — o contrato já
 * estava pronto para a API real antes desta etapa; aqui só é implementado.
 */

export interface MesReferencia {
  valor: string;
  label: string;
}

export interface PontoEvolucaoVendas {
  data: string;
  label: string;
  vendas: number;
  faturamento: number;
}

export interface VendaResumoDashboard {
  id: string;
  codigo: string;
  numero: string;
  dataVenda: string;
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
  status: string;
}

export interface DashboardVendas {
  mesReferencia: string;
  mesLabel: string;
  mesesDisponiveis: MesReferencia[];
  vendasHoje: number;
  faturamentoHoje: number;
  vendasSemana: number;
  faturamentoSemana: number;
  vendasMes: number;
  faturamentoMes: number;
  ticketMedioMes: number;
  vendasMesAnterior: number;
  faturamentoMesAnterior: number;
  crescimentoMensalPercentual: number;
  evolucao: PontoEvolucaoVendas[];
  ultimasVendas: VendaResumoDashboard[];
}

export interface DashboardEstoque {
  produtosCadastrados: number;
  variantesCadastradas: number;
  pecasEmEstoque: number;
  produtosSemEstoque: number;
  custoEstoque: number;
  vendaPotencial: number;
  lucroPotencial: number;
  margemMediaPercentual: number;
  ticketMedioEstoque: number;
}

export interface PessoaResumo {
  id: string;
  nome: string;
  foto: string | null;
  detalhe: string;
  ativo: boolean;
  criadoEm: string;
}

export interface DashboardClientes {
  cadastrados: number;
  ativos: number;
  inativos: number;
  novosNoMes: number;
  compraramNoMes: number;
  ticketMedioPorCliente: number;
  recentes: PessoaResumo[];
}

export interface DashboardFornecedores {
  cadastrados: number;
  ativos: number;
  inativos: number;
  recentes: PessoaResumo[];
}

export interface RankingVendedor {
  vendedorId: string;
  nome: string;
  foto: string | null;
  vendas: number;
  faturamento: number;
  ticketMedio: number;
}

export interface DashboardVendedores {
  cadastrados: number;
  ativos: number;
  inativos: number;
  ranking: RankingVendedor[];
}

export interface ResumoDashboard {
  demonstracao: boolean;
  geradoEm: string;
  vendas: DashboardVendas;
  estoque: DashboardEstoque;
  clientes: DashboardClientes;
  fornecedores: DashboardFornecedores;
  vendedores: DashboardVendedores;
}
