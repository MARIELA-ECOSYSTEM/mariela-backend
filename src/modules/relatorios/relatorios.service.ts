import { Injectable } from "@nestjs/common";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import type { ProdutoDocument } from "../produtos/schemas/produto.schema.js";
import { arredondarMoeda, precoEfetivo } from "../produtos/utils/precos.util.js";
import type { RelatorioSerie, ResumoRelatorios } from "./relatorios.types.js";

const MESES_HISTORICO = 6;
const TOP_ESTOQUE_LIMITE = 6;

function porCategoria(produtos: ProdutoDocument[], valorDe: (produto: ProdutoDocument) => number): RelatorioSerie[] {
  const mapa = new Map<string, number>();
  for (const produto of produtos) {
    mapa.set(produto.categoria, (mapa.get(produto.categoria) ?? 0) + valorDe(produto));
  }
  return [...mapa.entries()]
    .map(([label, valor]) => ({ label, valor }))
    .sort((a, b) => b.valor - a.valor);
}

function cadastrosPorMes(produtos: ProdutoDocument[], agora: Date): RelatorioSerie[] {
  const meses: RelatorioSerie[] = [];
  for (let i = MESES_HISTORICO - 1; i >= 0; i -= 1) {
    const data = new Date(agora);
    data.setDate(1);
    data.setMonth(data.getMonth() - i);
    const label = data.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
    const total = produtos.filter(
      (produto) => produto.criadoEm.getMonth() === data.getMonth() && produto.criadoEm.getFullYear() === data.getFullYear(),
    ).length;
    meses.push({ label, valor: total });
  }
  return meses;
}

/**
 * Fonte de verdade de TODO número exibido em Relatórios — espelha
 * `src/services/mock/relatorios.mock.ts` (a especificação de fato do
 * contrato já consumido pela tela antes desta implementação), com
 * `demonstracao: false` porque os dados agora vêm do catálogo real.
 */
@Injectable()
export class RelatoriosService {
  constructor(private readonly produtosRepository: ProdutosRepository) {}

  async resumo(): Promise<ResumoRelatorios> {
    const agora = new Date();
    const produtos = await this.produtosRepository.listarTodosAtivos();

    const pecasEmEstoque = produtos.reduce((total, produto) => total + produto.quantidadeTotal, 0);
    const valorCustoEstoque = arredondarMoeda(
      produtos.reduce((total, produto) => total + produto.precoCusto * produto.quantidadeTotal, 0),
    );
    const valorVendaEstoque = arredondarMoeda(
      produtos.reduce((total, produto) => total + precoEfetivo(produto) * produto.quantidadeTotal, 0),
    );
    const margens = produtos.filter((produto) => produto.precoCusto > 0).map((produto) => produto.margemLucro);

    return {
      demonstracao: false,
      geradoEm: agora.toISOString(),
      totalProdutos: produtos.length,
      totalVariantes: produtos.reduce((total, produto) => total + produto.variantes.length, 0),
      pecasEmEstoque,
      produtosSemEstoque: produtos.filter((produto) => produto.quantidadeTotal === 0).length,
      valorCustoEstoque,
      valorVendaEstoque,
      margemMediaPercentual: margens.length
        ? arredondarMoeda(margens.reduce((total, margem) => total + margem, 0) / margens.length)
        : 0,
      produtosPorCategoria: porCategoria(produtos, () => 1),
      pecasPorCategoria: porCategoria(produtos, (produto) => produto.quantidadeTotal),
      topEstoque: [...produtos]
        .sort((a, b) => b.quantidadeTotal - a.quantidadeTotal)
        .slice(0, TOP_ESTOQUE_LIMITE)
        .map((produto) => ({ label: produto.nome, valor: produto.quantidadeTotal })),
      cadastrosPorMes: cadastrosPorMes(produtos, agora),
    };
  }
}
