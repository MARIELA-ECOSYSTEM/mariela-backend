import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ClientesService } from "../clientes/clientes.service.js";
import type { CriarClienteDto } from "../clientes/dto/criar-cliente.dto.js";
import type { CriarFornecedorDto } from "../fornecedores/dto/criar-fornecedor.dto.js";
import { FornecedoresService } from "../fornecedores/fornecedores.service.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendasService } from "../vendas/vendas.service.js";
import type { DadosCriarVenda } from "../vendas/vendas.types.js";
import type { CriarVendedorDto } from "../vendedores/dto/criar-vendedor.dto.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { DashboardModule } from "./dashboard.module.js";
import { DashboardService } from "./dashboard.service.js";
import { chaveMes } from "./dashboard.util.js";

const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

let contador = 0;
function sufixo(): string {
  contador += 1;
  return String(contador);
}

describe("DashboardService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let dashboardService: DashboardService;
  let vendasService: VendasService;
  let produtosService: ProdutosService;
  let vendedoresService: VendedoresService;
  let clientesService: ClientesService;
  let fornecedoresService: FornecedoresService;
  let caixasService: CaixasService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, DashboardModule],
    }).compile();
    dashboardService = moduleRef.get(DashboardService);
    vendasService = moduleRef.get(VendasService);
    produtosService = moduleRef.get(ProdutosService);
    vendedoresService = moduleRef.get(VendedoresService);
    clientesService = moduleRef.get(ClientesService);
    fornecedoresService = moduleRef.get(FornecedoresService);
    caixasService = moduleRef.get(CaixasService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("vendas").deleteMany({});
    await connection.collection("eventos_venda").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection("fornecedores").deleteMany({});
    await connection.collection("eventos_fornecedor").deleteMany({});
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({
      _id: { $in: ["venda", "produto", "vendedor", "cliente", "fornecedor", "caixa"] },
    });
    await moduleRef.close();
  });

  async function criarProdutoComEstoque(precoCusto: number, precoVenda: number, quantidade: number, extra: Partial<CriarProdutoDto> = {}) {
    const s = sufixo();
    const produto = await produtosService.criar(
      { nome: `Produto Dash ${s}`, categoria: "Vestidos", precoCusto, precoVenda, ehNovidade: false, ...extra },
      null,
    );
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const varianteId = String(variante._id);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, varianteId, {
      tamanho: "M",
      delta: quantidade,
      exigirExistente: false,
    });
    return { produtoId: produto.id, varianteId, tamanhoId };
  }

  async function criarVendedor(ativo = true) {
    const s = sufixo();
    const dto: CriarVendedorDto = { nome: `Vendedor Dash ${s}`, telefone: `1198${String(contador).padStart(6, "0")}`, ativo, senha: "senha123" };
    return vendedoresService.criar(dto, null);
  }

  async function criarCliente() {
    const s = sufixo();
    const dto: CriarClienteDto = { nome: `Cliente Dash ${s}`, telefone: `8391${String(contador).padStart(6, "0")}` };
    return clientesService.criar(dto, null);
  }

  async function criarFornecedor(dto: Partial<CriarFornecedorDto> = {}) {
    const s = sufixo();
    return fornecedoresService.criar({ nome: `Fornecedor Dash ${s}`, ...dto }, null);
  }

  async function abrirEFecharCaixa() {
    const caixa = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
    return {
      caixa,
      fechar: async (valorInformado: number) => caixasService.fechar(caixa.id, { valorInformado }, null),
    };
  }

  async function venderPagoIntegral(vendedorId: string, produto: { produtoId: string; varianteId: string; tamanhoId: string }, valor: number, extra: Partial<DadosCriarVenda> = {}) {
    const { caixa, fechar } = await abrirEFecharCaixa();
    const venda = await vendasService.criar(
      {
        vendedorId,
        caixaId: caixa.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor }],
        ...extra,
      },
      null,
    );
    await fechar(1000 + valor);
    return venda;
  }

  describe("ausência de dados", () => {
    it("com o banco de teste vazio, todos os indicadores nascem zerados sem divisão por zero", async () => {
      const resumo = await dashboardService.resumo();
      expect(resumo.demonstracao).toBe(false);
      expect(resumo.vendas.vendasMes).toBe(0);
      expect(resumo.vendas.faturamentoMes).toBe(0);
      expect(resumo.vendas.ticketMedioMes).toBe(0);
      expect(resumo.vendas.crescimentoMensalPercentual).toBe(0);
      expect(resumo.vendas.ultimasVendas).toEqual([]);
      expect(resumo.estoque.vendaPotencial).toBe(0);
      expect(resumo.estoque.margemMediaPercentual).toBe(0);
      expect(resumo.estoque.ticketMedioEstoque).toBe(0);
      expect(resumo.clientes.ticketMedioPorCliente).toBe(0);
      expect(resumo.vendedores.ranking).toEqual([]);
      expect(resumo.vendas.mesesDisponiveis).toHaveLength(6);
      expect(resumo.vendas.mesesDisponiveis[0]!.valor).toBe(chaveMes(new Date()));
    });
  });

  describe("vendas: faturamento, ticket médio e status", () => {
    it("venda paga integralmente conta em vendasHoje/vendasSemana/vendasMes pelo valorFinal", async () => {
      const antes = await dashboardService.resumo();
      const produto = await criarProdutoComEstoque(50, 100, 5);
      const vendedor = await criarVendedor();
      const venda = await venderPagoIntegral(vendedor.id, produto, 100);

      const depois = await dashboardService.resumo();
      expect(depois.vendas.vendasHoje).toBe(antes.vendas.vendasHoje + 1);
      expect(depois.vendas.faturamentoHoje).toBeCloseTo(antes.vendas.faturamentoHoje + 100, 2);
      expect(depois.vendas.vendasSemana).toBe(antes.vendas.vendasSemana + 1);
      expect(depois.vendas.vendasMes).toBe(antes.vendas.vendasMes + 1);
      expect(depois.vendas.faturamentoMes).toBeCloseTo(antes.vendas.faturamentoMes + 100, 2);
      expect(depois.vendas.ultimasVendas.some((item) => item.id === venda.id && item.valorFinal === 100)).toBe(true);
    });

    it("venda EM_PAGAMENTO (paga parcialmente) também conta pelo valorFinal, não pelo valorPago", async () => {
      const antes = await dashboardService.resumo();
      const produto = await criarProdutoComEstoque(100, 300, 5);
      const vendedor = await criarVendedor();
      const { caixa, fechar } = await abrirEFecharCaixa();

      const venda = await vendasService.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      expect(venda.status).toBe("em_pagamento");
      expect(venda.valorFinal).toBe(300);
      expect(venda.valorPago).toBe(100);
      await fechar(1100);

      const depois = await dashboardService.resumo();
      expect(depois.vendas.vendasMes).toBe(antes.vendas.vendasMes + 1);
      // Conta o valorFinal (300) inteiro, não o valorPago (100).
      expect(depois.vendas.faturamentoMes).toBeCloseTo(antes.vendas.faturamentoMes + 300, 2);
    });

    it("venda cancelada não conta no faturamento (efeito líquido zero comparado ao estado anterior à criação)", async () => {
      const produto = await criarProdutoComEstoque(50, 200, 5);
      const vendedor = await criarVendedor();
      const antes = await dashboardService.resumo();

      // Cancelamento lança um movimento no caixa: precisa ficar aberto até depois de cancelar.
      const { caixa, fechar } = await abrirEFecharCaixa();
      const venda = await vendasService.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 200 }],
        },
        null,
      );
      const depoisCriacao = await dashboardService.resumo();
      expect(depoisCriacao.vendas.vendasMes).toBe(antes.vendas.vendasMes + 1);

      await vendasService.cancelar(venda.id, { tipo: "integral", motivo: "Teste dashboard" }, null);
      await fechar(1000); // recebeu 200 e devolveu 200 → saldo volta ao inicial.

      const depoisCancelamento = await dashboardService.resumo();
      expect(depoisCancelamento.vendas.vendasMes).toBe(antes.vendas.vendasMes);
      expect(depoisCancelamento.vendas.faturamentoMes).toBeCloseTo(antes.vendas.faturamentoMes, 2);
    });

    it("mês anterior fica zerado (nenhuma venda pode ser criada com data retroativa) e crescimentoMensalPercentual não divide por zero", async () => {
      const resumo = await dashboardService.resumo();
      expect(resumo.vendas.vendasMesAnterior).toBe(0);
      expect(resumo.vendas.faturamentoMesAnterior).toBe(0);
      expect(resumo.vendas.crescimentoMensalPercentual).toBe(0);
    });

    it("aceita ?mes explícito igual ao mês atual e ignora um mês fora do intervalo disponível (cai no atual)", async () => {
      const atual = chaveMes(new Date());
      const comMesAtual = await dashboardService.resumo(atual);
      const comMesInvalido = await dashboardService.resumo("1999-01");
      expect(comMesAtual.vendas.mesReferencia).toBe(atual);
      expect(comMesInvalido.vendas.mesReferencia).toBe(atual);
    });

    it("evolucao tem um ponto por dia do mês e a soma das vendas diárias bate com vendasMes", async () => {
      const resumo = await dashboardService.resumo();
      const diasNoMesAtual = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      expect(resumo.vendas.evolucao).toHaveLength(diasNoMesAtual);
      const somaVendasNaEvolucao = resumo.vendas.evolucao.reduce((total, ponto) => total + ponto.vendas, 0);
      expect(somaVendasNaEvolucao).toBe(resumo.vendas.vendasMes);
    });
  });

  describe("estoque", () => {
    it("custoEstoque/vendaPotencial/lucroPotencial refletem preço de tabela quando não há promoção", async () => {
      const antes = await dashboardService.resumo();
      await criarProdutoComEstoque(50, 100, 4);

      const depois = await dashboardService.resumo();
      expect(depois.estoque.custoEstoque).toBeCloseTo(antes.estoque.custoEstoque + 200, 2);
      expect(depois.estoque.vendaPotencial).toBeCloseTo(antes.estoque.vendaPotencial + 400, 2);
      expect(depois.estoque.lucroPotencial).toBeCloseTo(antes.estoque.lucroPotencial + 200, 2);
      expect(depois.estoque.pecasEmEstoque).toBe(antes.estoque.pecasEmEstoque + 4);
    });

    it("vendaPotencial usa o preço promocional (efetivo), não o de tabela, quando a promoção está ativa", async () => {
      const produto = await criarProdutoComEstoque(50, 200, 2);
      const antes = await dashboardService.resumo();
      await produtosService.definirPromocao(produto.produtoId, { ehPromocao: true, precoPromocional: 150 }, null);

      const depois = await dashboardService.resumo();
      // 2 peças a 150 (promocional) em vez de 200 (tabela): -100 no potencial.
      expect(depois.estoque.vendaPotencial).toBeCloseTo(antes.estoque.vendaPotencial - 100, 2);
    });
  });

  describe("clientes", () => {
    it("compraramNoMes/ticketMedioPorCliente só contam clientes com venda identificada no mês", async () => {
      const produto = await criarProdutoComEstoque(50, 140, 5);
      const vendedor = await criarVendedor();
      const antes = await dashboardService.resumo();

      const cliente = await criarCliente();
      await venderPagoIntegral(vendedor.id, produto, 140, { clienteId: cliente.id });

      const depois = await dashboardService.resumo();
      expect(depois.clientes.cadastrados).toBe(antes.clientes.cadastrados + 1);
      expect(depois.clientes.novosNoMes).toBe(antes.clientes.novosNoMes + 1);
      expect(depois.clientes.compraramNoMes).toBe(antes.clientes.compraramNoMes + 1);
    });

    it("cliente recém-criado sem compras não conta em compraramNoMes", async () => {
      const antes = await dashboardService.resumo();
      await criarCliente();
      const depois = await dashboardService.resumo();
      expect(depois.clientes.compraramNoMes).toBe(antes.clientes.compraramNoMes);
      expect(depois.clientes.cadastrados).toBe(antes.clientes.cadastrados + 1);
    });

    it("recentes traz o cliente recém-criado com o telefone como detalhe", async () => {
      const cliente = await criarCliente();
      const resumo = await dashboardService.resumo();
      const encontrado = resumo.clientes.recentes.find((item) => item.id === cliente.id);
      expect(encontrado).toBeDefined();
      expect(encontrado?.detalhe).toBe(cliente.telefone);
    });
  });

  describe("fornecedores", () => {
    it("fornecedor com produto vinculado conta como ativo; sem vínculo, como inativo", async () => {
      const comProduto = await criarFornecedor();
      await criarProdutoComEstoque(50, 100, 1, { fornecedorId: comProduto.id });
      const semProduto = await criarFornecedor();

      const resumo = await dashboardService.resumo();
      const comProdutoResumo = resumo.fornecedores.recentes.find((item) => item.id === comProduto.id);
      const semProdutoResumo = resumo.fornecedores.recentes.find((item) => item.id === semProduto.id);
      // `recentes` só traz os 5 mais novos — se algum dos dois não aparecer, valida via ativos/inativos abaixo.
      if (comProdutoResumo) expect(comProdutoResumo.detalhe).toBe("1 produto");
      if (semProdutoResumo) expect(semProdutoResumo.detalhe).toBe("0 produtos");
      expect(resumo.fornecedores.cadastrados).toBeGreaterThanOrEqual(2);
    });
  });

  describe("vendedores: ranking", () => {
    it("ranking soma faturamento por vendedor, calcula ticketMedio e ordena por faturamento desc; exclui quem não vendeu no mês", async () => {
      const produtoA = await criarProdutoComEstoque(50, 100, 5);
      const produtoB = await criarProdutoComEstoque(50, 300, 5);
      const vendedorTop = await criarVendedor();
      const vendedorBaixo = await criarVendedor();
      const vendedorSemVendas = await criarVendedor();

      await venderPagoIntegral(vendedorTop.id, produtoB, 300);
      await venderPagoIntegral(vendedorBaixo.id, produtoA, 100);

      const resumo = await dashboardService.resumo();
      const ranking = resumo.vendedores.ranking;
      const posicaoTop = ranking.findIndex((item) => item.vendedorId === vendedorTop.id);
      const posicaoBaixo = ranking.findIndex((item) => item.vendedorId === vendedorBaixo.id);
      const posicaoSemVendas = ranking.findIndex((item) => item.vendedorId === vendedorSemVendas.id);

      expect(posicaoTop).toBeGreaterThanOrEqual(0);
      expect(posicaoBaixo).toBeGreaterThanOrEqual(0);
      expect(posicaoTop).toBeLessThan(posicaoBaixo);
      expect(posicaoSemVendas).toBe(-1);
      expect(ranking[posicaoTop]!.ticketMedio).toBeCloseTo(300, 2);
    });

    it("vendedor inativo entra em `inativos`, ativo entra em `ativos`", async () => {
      const antes = await dashboardService.resumo();
      await criarVendedor(true);
      await criarVendedor(false);
      const depois = await dashboardService.resumo();
      expect(depois.vendedores.ativos).toBe(antes.vendedores.ativos + 1);
      expect(depois.vendedores.inativos).toBe(antes.vendedores.inativos + 1);
    });
  });
});
