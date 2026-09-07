import { Injectable } from "@nestjs/common";
import { ClientesRepository } from "../clientes/clientes.repository.js";
import { FornecedoresRepository } from "../fornecedores/fornecedores.repository.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import { arredondarMoeda, precoEfetivo } from "../produtos/utils/precos.util.js";
import type { VendaDocument } from "../vendas/schemas/venda.schema.js";
import { VendasRepository, type VendaResumoFinanceiro } from "../vendas/vendas.repository.js";
import { VendedoresRepository } from "../vendedores/vendedores.repository.js";
import { QUANTIDADE_RECENTES, QUANTIDADE_ULTIMAS_VENDAS } from "./dashboard.constants.js";
import type {
  DashboardClientes,
  DashboardEstoque,
  DashboardFornecedores,
  DashboardVendas,
  DashboardVendedores,
  PessoaResumo,
  PontoEvolucaoVendas,
  RankingVendedor,
  ResumoDashboard,
  VendaResumoDashboard,
} from "./dashboard.types.js";
import {
  calcularMesAnterior,
  calcularMesesDisponiveis,
  chaveMes,
  diasNoMes,
  labelMes,
  limitesDaSemana,
  limitesDeHoje,
  limitesDoMes,
  resolverMesReferencia,
  somarValorFinal,
} from "./dashboard.util.js";

/** Vendas contabilizadas nos indicadores comerciais: canceladas nunca entram no faturamento. */
function faturaveis(vendas: VendaResumoFinanceiro[]): VendaResumoFinanceiro[] {
  return vendas.filter((venda) => venda.status !== "cancelada");
}

function paraResumoVenda(venda: VendaDocument): VendaResumoDashboard {
  return {
    id: venda.id,
    codigo: venda.codigo,
    numero: venda.numero,
    dataVenda: venda.dataVenda.toISOString(),
    clienteId: venda.clienteId,
    clienteNome: venda.clienteNome,
    vendedorId: venda.vendedorId,
    vendedorNome: venda.vendedorNome,
    caixaId: venda.caixaId,
    caixaCodigo: venda.caixaCodigo,
    totalItens: venda.totalItens,
    valorBruto: venda.valorBruto,
    descontoPromocional: venda.descontoPromocional,
    descontoVenda: venda.descontoVenda,
    descontoTotal: venda.descontoTotal,
    valorFinal: venda.valorFinal,
    valorPago: venda.valorPago,
    valorPendente: venda.valorPendente,
    valorDevolvido: venda.valorDevolvido,
    temPromocao: venda.temPromocao,
    temDesconto: venda.temDesconto,
    formaPagamento: venda.formaPagamento,
    totalParcelas: venda.totalParcelas,
    parcelasPagas: venda.parcelasPagas,
    status: venda.status,
  };
}

function evolucaoDoMes(vendasDoMes: VendaResumoFinanceiro[], chave: string): PontoEvolucaoVendas[] {
  const [, mes] = chave.split("-");
  const pontos: PontoEvolucaoVendas[] = [];
  for (let dia = 1; dia <= diasNoMes(chave); dia += 1) {
    const doDia = vendasDoMes.filter((venda) => venda.dataVenda.getDate() === dia);
    pontos.push({
      data: `${chave}-${String(dia).padStart(2, "0")}`,
      label: `${String(dia).padStart(2, "0")}/${mes}`,
      vendas: doDia.length,
      faturamento: somarValorFinal(doDia),
    });
  }
  return pontos;
}

function recentes(
  lista: { id: string; nome: string; foto: string | null; criadoEm: Date }[],
  detalheDe: (id: string) => string,
): PessoaResumo[] {
  return [...lista]
    .sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime())
    .slice(0, QUANTIDADE_RECENTES)
    .map((item) => ({
      id: item.id,
      nome: item.nome,
      foto: item.foto,
      ativo: true,
      criadoEm: item.criadoEm.toISOString(),
      detalhe: detalheDe(item.id),
    }));
}

/**
 * Fonte de verdade de TODO número exibido no Dashboard — o frontend só
 * solicita, renderiza e navega (ver `src/routes/_backoffice/dashboard.tsx`),
 * nunca deriva métrica de negócio por conta própria. Cada fórmula abaixo
 * espelha `src/services/mock/dashboard.mock.ts`, a especificação de fato do
 * contrato já consumido pela tela antes desta implementação.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly vendasRepository: VendasRepository,
    private readonly produtosRepository: ProdutosRepository,
    private readonly clientesRepository: ClientesRepository,
    private readonly fornecedoresRepository: FornecedoresRepository,
    private readonly vendedoresRepository: VendedoresRepository,
  ) {}

  async resumo(mesSolicitado?: string): Promise<ResumoDashboard> {
    const agora = new Date();
    const mesesDisponiveis = calcularMesesDisponiveis(agora);
    const chave = resolverMesReferencia(mesSolicitado, mesesDisponiveis);
    const chaveAnterior = calcularMesAnterior(chave);

    const { inicio: inicioMesAtual, fim: fimMesAtual } = limitesDoMes(chave);
    const { inicio: inicioMesAnterior } = limitesDoMes(chaveAnterior);
    const { inicio: inicioHoje, fim: fimHoje } = limitesDeHoje(agora);
    const { inicio: inicioSemana } = limitesDaSemana(agora);

    // `inicioMesAnterior` e `fimMesAtual` são contíguos (mês anterior termina
    // exatamente onde o mês atual começa) — uma única consulta cobre os dois
    // recortes, separados depois em memória por `dataVenda`.
    const [vendasSemanaRaw, vendasDoisMesesRaw, vendasRecentes] = await Promise.all([
      this.vendasRepository.encontrarNoIntervalo(inicioSemana, fimHoje),
      this.vendasRepository.encontrarNoIntervalo(inicioMesAnterior, fimMesAtual),
      this.vendasRepository.encontrarRecentes(QUANTIDADE_ULTIMAS_VENDAS),
    ]);

    const daSemana = faturaveis(vendasSemanaRaw);
    const doHoje = daSemana.filter((venda) => venda.dataVenda >= inicioHoje);
    const doisMeses = faturaveis(vendasDoisMesesRaw);
    const doMesAtual = doisMeses.filter((venda) => venda.dataVenda >= inicioMesAtual);
    const doMesAnterior = doisMeses.filter((venda) => venda.dataVenda < inicioMesAtual);

    const faturamentoMes = somarValorFinal(doMesAtual);
    const faturamentoMesAnterior = somarValorFinal(doMesAnterior);

    const vendas: DashboardVendas = {
      mesReferencia: chave,
      mesLabel: labelMes(chave),
      mesesDisponiveis,
      vendasHoje: doHoje.length,
      faturamentoHoje: somarValorFinal(doHoje),
      vendasSemana: daSemana.length,
      faturamentoSemana: somarValorFinal(daSemana),
      vendasMes: doMesAtual.length,
      faturamentoMes,
      ticketMedioMes: doMesAtual.length ? arredondarMoeda(faturamentoMes / doMesAtual.length) : 0,
      vendasMesAnterior: doMesAnterior.length,
      faturamentoMesAnterior,
      crescimentoMensalPercentual: faturamentoMesAnterior
        ? arredondarMoeda(((faturamentoMes - faturamentoMesAnterior) / faturamentoMesAnterior) * 100)
        : 0,
      evolucao: evolucaoDoMes(doMesAtual, chave),
      ultimasVendas: vendasRecentes.map(paraResumoVenda),
    };

    const [produtos, clientes, fornecedores, vendedores] = await Promise.all([
      this.produtosRepository.listarTodosAtivos(),
      this.clientesRepository.encontrarTodosAtivos(),
      this.fornecedoresRepository.encontrarTodosAtivos(),
      this.vendedoresRepository.encontrarTodosAtivos(),
    ]);

    const pecasEmEstoque = produtos.reduce((total, produto) => total + produto.quantidadeTotal, 0);
    const custoEstoque = arredondarMoeda(produtos.reduce((total, produto) => total + produto.precoCusto * produto.quantidadeTotal, 0));
    const vendaPotencial = arredondarMoeda(
      produtos.reduce((total, produto) => total + precoEfetivo(produto) * produto.quantidadeTotal, 0),
    );
    const estoque: DashboardEstoque = {
      produtosCadastrados: produtos.length,
      variantesCadastradas: produtos.reduce((total, produto) => total + produto.variantes.length, 0),
      pecasEmEstoque,
      produtosSemEstoque: produtos.filter((produto) => produto.quantidadeTotal === 0).length,
      custoEstoque,
      vendaPotencial,
      lucroPotencial: arredondarMoeda(vendaPotencial - custoEstoque),
      margemMediaPercentual: vendaPotencial ? arredondarMoeda(((vendaPotencial - custoEstoque) / vendaPotencial) * 100) : 0,
      ticketMedioEstoque: pecasEmEstoque ? arredondarMoeda(vendaPotencial / pecasEmEstoque) : 0,
    };

    const compradoresNoMes = new Set(doMesAtual.map((venda) => venda.clienteId).filter((id): id is string => Boolean(id)));
    const faturamentoIdentificado = somarValorFinal(doMesAtual.filter((venda) => venda.clienteId));
    const dashboardClientes: DashboardClientes = {
      cadastrados: clientes.length,
      // Cliente não possui status ativo/inativo — todo cadastro é considerado ativo (mesma decisão do mock).
      ativos: clientes.length,
      inativos: 0,
      novosNoMes: clientes.filter((cliente) => chaveMes(cliente.criadoEm) === chave).length,
      compraramNoMes: compradoresNoMes.size,
      ticketMedioPorCliente: compradoresNoMes.size ? arredondarMoeda(faturamentoIdentificado / compradoresNoMes.size) : 0,
      recentes: recentes(clientes, (id) => clientes.find((cliente) => cliente.id === id)?.telefone ?? ""),
    };

    const produtosPorFornecedor = new Map<string, number>();
    for (const produto of produtos) {
      if (!produto.fornecedorId) continue;
      produtosPorFornecedor.set(produto.fornecedorId, (produtosPorFornecedor.get(produto.fornecedorId) ?? 0) + 1);
    }
    const dashboardFornecedores: DashboardFornecedores = {
      cadastrados: fornecedores.length,
      // Fornecedor não possui status: o indicador mede vínculo com produtos (mesma decisão do mock).
      ativos: fornecedores.filter((fornecedor) => (produtosPorFornecedor.get(fornecedor.id) ?? 0) > 0).length,
      inativos: fornecedores.filter((fornecedor) => (produtosPorFornecedor.get(fornecedor.id) ?? 0) === 0).length,
      recentes: recentes(fornecedores, (id) => {
        const total = produtosPorFornecedor.get(id) ?? 0;
        return `${total} ${total === 1 ? "produto" : "produtos"}`;
      }),
    };

    const ranking: RankingVendedor[] = vendedores
      .map((vendedor) => {
        const suas = doMesAtual.filter((venda) => venda.vendedorId === vendedor.id);
        const faturamento = somarValorFinal(suas);
        return {
          vendedorId: vendedor.id,
          nome: vendedor.nome,
          foto: vendedor.foto,
          vendas: suas.length,
          faturamento,
          ticketMedio: suas.length ? arredondarMoeda(faturamento / suas.length) : 0,
        };
      })
      .filter((item) => item.vendas > 0)
      .sort((a, b) => b.faturamento - a.faturamento);

    const dashboardVendedores: DashboardVendedores = {
      cadastrados: vendedores.length,
      ativos: vendedores.filter((vendedor) => vendedor.ativo).length,
      inativos: vendedores.filter((vendedor) => !vendedor.ativo).length,
      ranking,
    };

    return {
      demonstracao: false,
      geradoEm: agora.toISOString(),
      vendas,
      estoque,
      clientes: dashboardClientes,
      fornecedores: dashboardFornecedores,
      vendedores: dashboardVendedores,
    };
  }
}
