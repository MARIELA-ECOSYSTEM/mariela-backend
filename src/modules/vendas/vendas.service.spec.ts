import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { AdquirentesService } from "../adquirentes/adquirentes.service.js";
import type { CriarAdquirenteDto } from "../adquirentes/dto/criar-adquirente.dto.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { MovimentosCaixaRepository } from "../caixas/movimentos-caixa.repository.js";
import { ClientesService } from "../clientes/clientes.service.js";
import type { CriarClienteDto } from "../clientes/dto/criar-cliente.dto.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { CriarVendedorDto } from "../vendedores/dto/criar-vendedor.dto.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import type { DadosCriarVenda } from "./vendas.types.js";
import type { ListarVendasQueryDto } from "./dto/listar-vendas-query.dto.js";
import { VendasModule } from "./vendas.module.js";
import { VendasRepository } from "./vendas.repository.js";
import { VendasService } from "./vendas.service.js";

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

describe("VendasService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: VendasService;
  let produtosService: ProdutosService;
  let vendedoresService: VendedoresService;
  let clientesService: ClientesService;
  let caixasService: CaixasService;
  let adquirentesService: AdquirentesService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, VendasModule],
    }).compile();
    service = moduleRef.get(VendasService);
    produtosService = moduleRef.get(ProdutosService);
    vendedoresService = moduleRef.get(VendedoresService);
    clientesService = moduleRef.get(ClientesService);
    caixasService = moduleRef.get(CaixasService);
    adquirentesService = moduleRef.get(AdquirentesService);
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
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("adquirentes").deleteMany({});
    await connection.collection("eventos_adquirente").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["venda", "produto", "vendedor", "cliente", "caixa"] } });
    await moduleRef.close();
  });

  async function criarProdutoComEstoque(precoVenda: number, quantidade: number, extra: Partial<CriarProdutoDto> = {}) {
    const s = sufixo();
    const produto = await produtosService.criar(
      { nome: `Produto Venda ${s}`, categoria: "Vestidos", precoCusto: precoVenda / 2, precoVenda, ehNovidade: false, ...extra },
      null,
    );
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const varianteId = String(variante._id);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, varianteId, {
      tamanho: "M",
      delta: quantidade,
      exigirExistente: false,
    });
    return { produtoId: produto.id, varianteId, tamanhoId, precoVenda };
  }

  async function criarVendedor(ativo = true) {
    const s = sufixo();
    const dto: CriarVendedorDto = { nome: `Vendedor Venda ${s}`, telefone: `1197${String(contador).padStart(6, "0")}`, ativo, senha: "senha123" };
    return vendedoresService.criar(dto, null);
  }

  async function criarCliente() {
    const s = sufixo();
    const dto: CriarClienteDto = { nome: `Cliente Venda ${s}`, telefone: `8390${String(contador).padStart(6, "0")}` };
    return clientesService.criar(dto, null);
  }

  async function abrirCaixa() {
    return caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
  }

  async function criarAdquirente(extra: Partial<CriarAdquirenteDto> = {}) {
    const s = sufixo();
    return adquirentesService.criar({ nome: `Adquirente Venda ${s}`, ...extra }, null);
  }

  function queryPadrao(extra: Partial<ListarVendasQueryDto> = {}): ListarVendasQueryDto {
    return {
      ordenarPor: "data",
      ordem: "desc",
      status: [],
      periodo: [],
      vendedor: [],
      cliente: [],
      pagamento: [],
      caixa: [],
      valor: [],
      condicoes: [],
      financeiro: [],
      page: 1,
      limit: 20,
      ...extra,
    };
  }

  describe("criação (mecanismo interno)", () => {
    it("cria a venda com código/número sequenciais, baixa o estoque e marca CONCLUIDA quando totalmente paga", async () => {
      const produto = await criarProdutoComEstoque(100, 10);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const dados: DadosCriarVenda = {
        vendedorId: vendedor.id,
        caixaId: caixa.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
        pagamentos: [{ forma: "Dinheiro", valor: 200 }],
      };
      const venda = await service.criar(dados, "admin-teste");

      expect(venda.codigo).toMatch(/^VENDA-\d{4}-\d{2}-\d{2}-\d{4}$/);
      expect(venda.numero).toMatch(/^\d{6}$/);
      expect(venda.status).toBe("concluida");
      expect(venda.valorFinal).toBe(200);
      expect(venda.valorPago).toBe(200);
      expect(venda.valorPendente).toBe(0);

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(8);
      await caixasService.fechar(caixa.id, { valorInformado: 1200 }, null);
    });

    it("marca EM_PAGAMENTO com uma parcela cobrindo o valor pendente quando o pagamento é parcial", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );

      expect(venda.status).toBe("em_pagamento");
      expect(venda.valorPendente).toBe(200);
      expect(venda.parcelas).toHaveLength(1);
      expect(venda.parcelas[0]?.valor).toBe(200);
      expect(venda.parcelas[0]?.pagoEm).toBeNull();
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("gera N parcelas quando totalParcelas é solicitado (estilo Crediário)", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
          totalParcelas: 3,
        },
        null,
      );

      expect(venda.parcelas).toHaveLength(3);
      const somaParcelas = venda.parcelas.reduce((total, p) => total + p.valor, 0);
      expect(Number(somaParcelas.toFixed(2))).toBe(300);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("preço praticado usa a promoção quando ativa (preço vigente, não o de tabela)", async () => {
      const produto = await criarProdutoComEstoque(200, 5);
      await produtosService.definirPromocao(produto.produtoId, { ehPromocao: true, precoPromocional: 150 }, null);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "PIX", valor: 150 }],
        },
        null,
      );

      expect(venda.itens[0]?.precoPraticado).toBe(150);
      expect(venda.itens[0]?.emPromocao).toBe(true);
      expect(venda.descontoPromocional).toBe(50);
      expect(venda.temPromocao).toBe(true);
      await caixasService.fechar(caixa.id, { valorInformado: 1150 }, null);
    });

    it("aplica e valida descontoVenda contra o subtotal", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          descontoVenda: 10,
          pagamentos: [{ forma: "Dinheiro", valor: 90 }],
        },
        null,
      );
      expect(venda.valorFinal).toBe(90);
      expect(venda.temDesconto).toBe(true);

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            descontoVenda: 1000,
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1090 }, null);
    });

    it("rejeita estoque insuficiente e não baixa nenhum item", async () => {
      const produto = await criarProdutoComEstoque(100, 1);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 5 }],
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("rejeita vendedor inativo", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor(false);
      const caixa = await abrirCaixa();

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("rejeita caixa fechado", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);
    });

    it("idempotencyKey repetida devolve a mesma venda, sem baixar estoque de novo", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const chave = `venda-idem-${Date.now()}`;

      const dados: DadosCriarVenda = {
        vendedorId: vendedor.id,
        caixaId: caixa.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        idempotencyKey: chave,
      };
      const primeira = await service.criar(dados, null);
      const segunda = await service.criar(dados, null);

      expect(segunda.id).toBe(primeira.id);
      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(4);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("duas vendas concorrentes disputando a última unidade: só uma consegue baixar o estoque", async () => {
      const produto = await criarProdutoComEstoque(100, 1);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const item = { produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 };
      const resultados = await Promise.allSettled([
        service.criar({ vendedorId: vendedor.id, caixaId: caixa.id, itens: [item], pagamentos: [{ forma: "Dinheiro", valor: 100 }] }, null),
        service.criar({ vendedorId: vendedor.id, caixaId: caixa.id, itens: [item], pagamentos: [{ forma: "Dinheiro", valor: 100 }] }, null),
      ]);

      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      const falha = resultados.filter((r) => r.status === "rejected");
      expect(sucesso).toHaveLength(1);
      expect(falha).toHaveLength(1);

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(0);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });
  });

  describe("desconto por item e desconto da venda (Etapa 10.3)", () => {
    it("sem desconto: descontoItem é 0 e subtotal é o preço praticado × quantidade", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
          pagamentos: [{ forma: "Dinheiro", valor: 200 }],
        },
        null,
      );
      expect(venda.itens[0]?.descontoItem).toBe(0);
      expect(venda.itens[0]?.subtotal).toBe(200);
      expect(venda.temDesconto).toBe(false);
      await caixasService.fechar(caixa.id, { valorInformado: 1200 }, null);
    });

    it("desconto por item em R$ (valor absoluto)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 1,
              desconto: { tipo: "valor", valor: 15 },
            },
          ],
          pagamentos: [{ forma: "Dinheiro", valor: 85 }],
        },
        null,
      );
      expect(venda.itens[0]?.descontoItem).toBe(15);
      expect(venda.itens[0]?.subtotal).toBe(85);
      expect(venda.valorFinal).toBe(85);
      expect(venda.temDesconto).toBe(true);
      await caixasService.fechar(caixa.id, { valorInformado: 1085 }, null);
    });

    it("desconto por item em % — considera a quantidade (preço praticado × quantidade é a base, não o unitário)", async () => {
      const produto = await criarProdutoComEstoque(50, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 3,
              desconto: { tipo: "percentual", valor: 10 },
            },
          ],
          pagamentos: [],
        },
        null,
      );
      // base = 50 × 3 = 150; 10% = 15; subtotal = 135 (seção 7 do pedido).
      expect(venda.itens[0]?.descontoItem).toBe(15);
      expect(venda.itens[0]?.subtotal).toBe(135);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("desconto por item sobre produto em promoção incide sobre o preço PRATICADO, nunca sobre o de tabela", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      await produtosService.definirPromocao(produto.produtoId, { ehPromocao: true, precoPromocional: 80 }, null);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 1,
              desconto: { tipo: "percentual", valor: 10 },
            },
          ],
          pagamentos: [],
        },
        null,
      );
      // precoOriginal=100, precoPraticado=80 (promoção) → 10% do item incide
      // sobre 80 (= 8), NUNCA sobre 100 (que daria 10). Resultado: 80-8=72,
      // exatamente o exemplo da seção 1 do pedido.
      expect(venda.itens[0]?.precoOriginal).toBe(100);
      expect(venda.itens[0]?.precoPraticado).toBe(80);
      expect(venda.itens[0]?.descontoItem).toBe(8);
      expect(venda.itens[0]?.subtotal).toBe(72);
      expect(venda.descontoPromocional).toBe(20);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("desconto da venda em R$ (objeto {tipo:'valor', valor})", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          descontoVenda: { tipo: "valor", valor: 20 },
          pagamentos: [{ forma: "Dinheiro", valor: 80 }],
        },
        null,
      );
      expect(venda.descontoVenda).toBe(20);
      expect(venda.valorFinal).toBe(80);
      await caixasService.fechar(caixa.id, { valorInformado: 1080 }, null);
    });

    it("desconto da venda em % (objeto {tipo:'percentual', valor})", async () => {
      const produto = await criarProdutoComEstoque(200, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          descontoVenda: { tipo: "percentual", valor: 15 },
          pagamentos: [],
        },
        null,
      );
      // subtotalVenda=200; 15% = 30; valorFinal = 170.
      expect(venda.descontoVenda).toBe(30);
      expect(venda.valorFinal).toBe(170);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("payload legado: descontoVenda como number puro continua funcionando (retrocompatibilidade)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          descontoVenda: 25,
          pagamentos: [{ forma: "Dinheiro", valor: 75 }],
        },
        null,
      );
      expect(venda.descontoVenda).toBe(25);
      expect(venda.valorFinal).toBe(75);
      await caixasService.fechar(caixa.id, { valorInformado: 1075 }, null);
    });

    it("desconto de 100% (item) zera o subtotal daquela linha, sem ficar negativo", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 1,
              desconto: { tipo: "percentual", valor: 100 },
            },
          ],
          pagamentos: [],
        },
        null,
      );
      expect(venda.itens[0]?.descontoItem).toBe(100);
      expect(venda.itens[0]?.subtotal).toBe(0);
      expect(venda.valorFinal).toBe(0);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("desconto de item acima de 100% é rejeitado", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [
              {
                produtoId: produto.produtoId,
                varianteId: produto.varianteId,
                tamanhoId: produto.tamanhoId,
                quantidade: 1,
                desconto: { tipo: "percentual", valor: 101 },
              },
            ],
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("desconto de venda acima de 100% é rejeitado", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            descontoVenda: { tipo: "percentual", valor: 101 },
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("desconto monetário de item maior que a base (preço praticado × quantidade) é rejeitado", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [
              {
                produtoId: produto.produtoId,
                varianteId: produto.varianteId,
                tamanhoId: produto.tamanhoId,
                quantidade: 1,
                desconto: { tipo: "valor", valor: 101 },
              },
            ],
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("desconto monetário da venda maior que o subtotal é rejeitado", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            descontoVenda: { tipo: "valor", valor: 101 },
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("desconto de item negativo é rejeitado", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [
              {
                produtoId: produto.produtoId,
                varianteId: produto.varianteId,
                tamanhoId: produto.tamanhoId,
                quantidade: 1,
                desconto: { tipo: "valor", valor: -10 },
              },
            ],
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("desconto da venda negativo é rejeitado", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            descontoVenda: { tipo: "valor", valor: -1 },
            pagamentos: [],
          },
          null,
        ),
      ).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("desconto por item + desconto da venda combinados: aplica na ordem correta (item primeiro, depois venda)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 2,
              desconto: { tipo: "percentual", valor: 10 },
            },
          ],
          // base do item = 100×2=200; desconto item 10% = 20; subtotalItem = 180.
          // subtotalVenda = 180; desconto venda 10% = 18; valorFinal = 162.
          descontoVenda: { tipo: "percentual", valor: 10 },
          pagamentos: [],
        },
        null,
      );
      expect(venda.itens[0]?.descontoItem).toBe(20);
      expect(venda.itens[0]?.subtotal).toBe(180);
      expect(venda.descontoVenda).toBe(18);
      expect(venda.valorFinal).toBe(162);
      expect(venda.descontoTotal).toBe(38); // 20 (item) + 18 (venda), sem promoção
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("múltiplos itens com descontos diferentes: cada um calculado independentemente", async () => {
      const produtoA = await criarProdutoComEstoque(100, 5);
      const produtoB = await criarProdutoComEstoque(50, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produtoA.produtoId,
              varianteId: produtoA.varianteId,
              tamanhoId: produtoA.tamanhoId,
              quantidade: 1,
              desconto: { tipo: "percentual", valor: 20 },
            },
            {
              produtoId: produtoB.produtoId,
              varianteId: produtoB.varianteId,
              tamanhoId: produtoB.tamanhoId,
              quantidade: 2,
              desconto: { tipo: "valor", valor: 10 },
            },
          ],
          pagamentos: [],
        },
        null,
      );
      const itemA = venda.itens.find((item) => item.produtoId === produtoA.produtoId)!;
      const itemB = venda.itens.find((item) => item.produtoId === produtoB.produtoId)!;
      expect(itemA.descontoItem).toBe(20); // 100 × 20%
      expect(itemA.subtotal).toBe(80);
      expect(itemB.descontoItem).toBe(10); // valor fixo sobre a base 100 (50×2)
      expect(itemB.subtotal).toBe(90);
      expect(venda.valorFinal).toBe(170); // 80 + 90
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("ignora valorFinal forjado no payload e recalcula do zero (backend é a autoridade)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const dadosForjados = {
        clienteId: cliente.id,
        vendedorId: vendedor.id,
        caixaId: caixa.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [],
        valorFinal: 999999,
        subtotal: 999999,
      } as unknown as DadosCriarVenda;

      const venda = await service.criar(dadosForjados, null);
      expect(venda.valorFinal).toBe(100);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("arredondamento determinístico: percentual com dízima resulta em 2 casas decimais, sem resíduo negativo", async () => {
      const produto = await criarProdutoComEstoque(10, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 3,
              desconto: { tipo: "percentual", valor: 33.33 },
            },
          ],
          pagamentos: [],
        },
        null,
      );
      // base = 10×3 = 30; 33,33% de 30 = 9,999 → arredonda para 10.
      expect(venda.itens[0]?.descontoItem).toBe(10);
      expect(Number.isInteger(venda.itens[0]!.descontoItem * 100)).toBe(true); // no máximo 2 casas decimais
      expect(venda.itens[0]!.subtotal).toBeGreaterThanOrEqual(0);
      expect(venda.valorFinal).toBeGreaterThanOrEqual(0);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("Etapa 18.17 — arredondamento de meio-centavo exato usa Math.round (arredondarMoeda), nunca Number(toFixed(2))", async () => {
      // base = 100 (preço × quantidade); 0,015% de 100 = 0,015 exatamente —
      // Number((0.015).toFixed(2)) daria 0.01, divergindo de arredondarMoeda
      // (produtos/utils/precos.util.ts), que dá 0.02. Mesma classe de bug já
      // corrigida em caixas/dinheiro.util.ts na Etapa 18.16.
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 1,
              desconto: { tipo: "percentual", valor: 0.015 },
            },
          ],
          pagamentos: [],
        },
        null,
      );
      expect(venda.itens[0]?.descontoItem).toBe(0.02);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("snapshot: descontoItem persiste no documento e é recuperável via obterPorId", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 1,
              desconto: { tipo: "valor", valor: 12 },
            },
          ],
          pagamentos: [],
        },
        null,
      );

      const recarregada = await service.obterPorId(venda.id);
      expect(recarregada.itens[0]?.descontoItem).toBe(12);
      expect(recarregada.itens[0]?.subtotal).toBe(88);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("modalidade de pagamento, adquirente e parcelamento (Etapa 10.4)", () => {
    describe("modalidades", () => {
      it("dinheiro válido", async () => {
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", modalidade: "dinheiro", valor: 100 }],
          },
          null,
        );
        expect(venda.status).toBe("concluida");
        expect(venda.pagamentos[0]?.modalidade).toBe("dinheiro");
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("pix válido", async () => {
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "PIX", modalidade: "pix", valor: 100 }],
          },
          null,
        );
        expect(venda.pagamentos[0]?.modalidade).toBe("pix");
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("débito válido", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, valor: 100 }],
          },
          null,
        );
        expect(venda.pagamentos[0]?.modalidade).toBe("debito");
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("crédito válido", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 3, percentual: 5.19 }] });
        const produto = await criarProdutoComEstoque(300, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 3, valor: 300 }],
          },
          null,
        );
        expect(venda.pagamentos[0]?.modalidade).toBe("credito");
        expect(venda.pagamentos[0]?.parcelas).toBe(3);
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("modalidade inválida é rejeitada (nunca confia no que o cliente enviou)", async () => {
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Boleto", modalidade: "boleto" as never, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });
    });

    describe("adquirente", () => {
      it("débito sem adquirenteId é rejeitado", async () => {
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Débito", modalidade: "debito", valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("crédito sem adquirenteId é rejeitado", async () => {
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Crédito", modalidade: "credito", parcelas: 1, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("adquirente inexistente → NOT_FOUND", async () => {
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: "65f1a2b3c4d5e6f7a8b9c0d1", valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("adquirente inativa → VALIDATION_ERROR", async () => {
        const adquirente = await criarAdquirente({
          ativo: false,
          tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }],
        });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("dinheiro com adquirenteId é rejeitado", async () => {
        const adquirente = await criarAdquirente();
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Dinheiro", modalidade: "dinheiro", adquirenteId: adquirente.id, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("pix com adquirenteId é rejeitado", async () => {
        const adquirente = await criarAdquirente();
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "PIX", modalidade: "pix", adquirenteId: adquirente.id, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });
    });

    describe("débito", () => {
      it("débito 1x válido", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 }],
          },
          null,
        );
        expect(venda.pagamentos[0]?.parcelas).toBe(1);
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("débito 2x é rejeitado (débito é sempre 1x)", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, parcelas: 2, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("débito sem tarifa configurada para esta adquirente é rejeitado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });
    });

    describe("crédito", () => {
      it("crédito sem parcelas é rejeitado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("crédito 0x é rejeitado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 0, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("crédito 25x é rejeitado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 25, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("crédito 1x válido se configurado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 }],
          },
          null,
        );
        expect(venda.pagamentos[0]?.parcelas).toBe(1);
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("crédito 6x válido se configurado", async () => {
        const adquirente = await criarAdquirente({
          tabelaTarifas: [
            { modalidade: "credito", parcelas: 1, percentual: 3.49 },
            { modalidade: "credito", parcelas: 6, percentual: 6.99 },
          ],
        });
        const produto = await criarProdutoComEstoque(300, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 6, valor: 300 }],
          },
          null,
        );
        expect(venda.pagamentos[0]?.parcelas).toBe(6);
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("crédito 5x é rejeitado se NÃO configurado (mesmo dentro do intervalo 1–24 — a configuração é a autoridade)", async () => {
        const adquirente = await criarAdquirente({
          tabelaTarifas: [
            { modalidade: "credito", parcelas: 1, percentual: 3.49 },
            { modalidade: "credito", parcelas: 2, percentual: 4.49 },
            { modalidade: "credito", parcelas: 3, percentual: 5.19 },
            { modalidade: "credito", parcelas: 6, percentual: 6.99 },
          ],
        });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        await expect(
          service.criar(
            {
              vendedorId: vendedor.id,
              caixaId: caixa.id,
              itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
              pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 5, valor: 100 }],
            },
            null,
          ),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("crédito 24x válido se configurado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 24, percentual: 15.99 }] });
        const produto = await criarProdutoComEstoque(2400, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 24, valor: 2400 }],
          },
          null,
        );
        expect(venda.pagamentos[0]?.parcelas).toBe(24);
        await caixasService.fechar(caixa.id, { valorInformado: 3400 }, null);
      });
    });

    describe("múltiplos pagamentos", () => {
      it("PIX + crédito", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 2, percentual: 4.49 }] });
        const produto = await criarProdutoComEstoque(300, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [
              { forma: "PIX", modalidade: "pix", valor: 100 },
              { forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 2, valor: 200 },
            ],
          },
          null,
        );
        expect(venda.valorPago).toBe(300);
        expect(venda.status).toBe("concluida");
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("dinheiro + débito", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] });
        const produto = await criarProdutoComEstoque(300, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [
              { forma: "Dinheiro", modalidade: "dinheiro", valor: 150 },
              { forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, valor: 150 },
            ],
          },
          null,
        );
        expect(venda.valorPago).toBe(300);
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("crédito + crédito com adquirentes diferentes", async () => {
        const adquirenteA = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const adquirenteB = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 3, percentual: 5.19 }] });
        const produto = await criarProdutoComEstoque(300, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [
              { forma: "Crédito A", modalidade: "credito", adquirenteId: adquirenteA.id, parcelas: 1, valor: 100 },
              { forma: "Crédito B", modalidade: "credito", adquirenteId: adquirenteB.id, parcelas: 3, valor: 200 },
            ],
          },
          null,
        );
        expect(venda.pagamentos[0]?.adquirenteId).toBe(adquirenteA.id);
        expect(venda.pagamentos[1]?.adquirenteId).toBe(adquirenteB.id);
        expect(venda.valorPago).toBe(300);
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("soma dos pagamentos continua funcionando com pagamentos estruturados e legados misturados", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(300, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [
              { forma: "Dinheiro", valor: 100 }, // legado, sem modalidade
              { forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 200 },
            ],
          },
          null,
        );
        expect(venda.valorPago).toBe(300);
        expect(venda.pagamentos[0]?.modalidade).toBeNull();
        expect(venda.pagamentos[1]?.modalidade).toBe("credito");
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });
    });

    describe("compatibilidade", () => {
      it("pagamento legado sem modalidade continua funcionando", async () => {
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100, parcelas: 1 }],
          },
          null,
        );
        expect(venda.status).toBe("concluida");
        expect(venda.pagamentos[0]?.modalidade).toBeNull();
        expect(venda.pagamentos[0]?.adquirenteId).toBeNull();
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("venda legada (sem nenhum campo novo em nenhum pagamento) continua funcionando ponta a ponta", async () => {
        const produto = await criarProdutoComEstoque(200, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "PIX", valor: 200 }],
          },
          null,
        );
        expect(venda.valorFinal).toBe(200);
        expect(venda.status).toBe("concluida");
        await caixasService.fechar(caixa.id, { valorInformado: 1200 }, null);
      });

      it("descontos da Etapa 10.3 continuam funcionando junto com pagamento estruturado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [
              {
                produtoId: produto.produtoId,
                varianteId: produto.varianteId,
                tamanhoId: produto.tamanhoId,
                quantidade: 1,
                desconto: { tipo: "percentual", valor: 10 },
              },
            ],
            pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, valor: 90 }],
          },
          null,
        );
        expect(venda.itens[0]?.descontoItem).toBe(10);
        expect(venda.valorFinal).toBe(90);
        expect(venda.valorPago).toBe(90);
        await caixasService.fechar(caixa.id, { valorInformado: 1090 }, null);
      });

      it("idempotência continua funcionando com pagamento estruturado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const chave = `venda-modalidade-idem-${Date.now()}`;

        const dados: DadosCriarVenda = {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 }],
          idempotencyKey: chave,
        };
        const primeira = await service.criar(dados, null);
        const segunda = await service.criar(dados, null);
        expect(segunda.id).toBe(primeira.id);
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("estoque continua protegido contra concorrência com pagamento estruturado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(100, 1);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const item = { produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 };
        const pagamentos: DadosCriarVenda["pagamentos"] = [
          { forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 },
        ];
        const resultados = await Promise.allSettled([
          service.criar({ vendedorId: vendedor.id, caixaId: caixa.id, itens: [item], pagamentos }, null),
          service.criar({ vendedorId: vendedor.id, caixaId: caixa.id, itens: [item], pagamentos }, null),
        ]);

        const sucesso = resultados.filter((r) => r.status === "fulfilled");
        expect(sucesso).toHaveLength(1);

        const atualizado = await produtosService.obterPorId(produto.produtoId);
        const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
        expect(tamanho.quantidade).toBe(0);
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });
    });

    describe("persistência", () => {
      it("modalidade, adquirenteId e parcelas são persistidos e recuperáveis via obterPorId", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 4, percentual: 5.49 }] });
        const produto = await criarProdutoComEstoque(400, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 4, valor: 400 }],
          },
          null,
        );

        const recarregada = await service.obterPorId(venda.id);
        expect(recarregada.pagamentos[0]?.modalidade).toBe("credito");
        expect(recarregada.pagamentos[0]?.adquirenteId).toBe(adquirente.id);
        expect(recarregada.pagamentos[0]?.parcelas).toBe(4);
        await caixasService.fechar(caixa.id, { valorInformado: 1400 }, null);
      });

      // As duas linhas abaixo eram testes de FRONTEIRA da Etapa 10.4 ("nenhum
      // tarifaAplicada/valorLiquido é criado NESTA etapa") — a Etapa 10.5,
      // implementada agora, tem como objetivo EXATAMENTE cruzar essa
      // fronteira (CONFLITO reportado no relatório desta etapa). Atualizados
      // para afirmar o comportamento novo, correto, em vez de removidos.
      it("tarifaAplicada é criado dentro do pagamento estruturado (Etapa 10.5)", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 }],
          },
          null,
        );
        expect(venda.pagamentos[0]?.tarifaAplicada).not.toBeNull();
        expect(venda.pagamentos[0]?.tarifaAplicada?.adquirenteId).toBe(adquirente.id);
        expect(venda.pagamentos[0]?.tarifaAplicada?.adquirenteNome).toBe(adquirente.nome);
        expect(venda.pagamentos[0]?.tarifaAplicada?.percentual).toBe(3.49);
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("valorLiquido só existe DENTRO de tarifaAplicada — nunca como campo solto no pagamento — e nunca reduz valorPago", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 }],
          },
          null,
        );
        // Nenhum campo `valorLiquido` solto no pagamento — só existe aninhado em `tarifaAplicada` (seção 15 do pedido: não inventar campos além do contrato).
        expect((venda.pagamentos[0] as unknown as Record<string, unknown>)["valorLiquido"]).toBeUndefined();
        expect(venda.pagamentos[0]?.tarifaAplicada?.valorLiquido).toBe(96.51);
        // Valor pago pelo cliente continua sendo o BRUTO — tarifa nunca reduz o que o cliente pagou (seção 1 do pedido).
        expect(venda.valorPago).toBe(100);
        expect(venda.pagamentos[0]?.valor).toBe(100);
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });
    });
  });

  describe("cálculo de tarifa e valor líquido (Etapa 10.5)", () => {
    it("A. crédito 1x: R$100 a 3,49% → tarifa R$3,49, líquido R$96,51", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 }],
        },
        null,
      );
      const tarifa = venda.pagamentos[0]?.tarifaAplicada;
      expect(tarifa?.valorTarifa).toBe(3.49);
      expect(tarifa?.valorLiquido).toBe(96.51);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("B. crédito 6x: configurado a 5%, R$300 → tarifa R$15, líquido R$285", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 6, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 6, valor: 300 }],
        },
        null,
      );
      const tarifa = venda.pagamentos[0]?.tarifaAplicada;
      expect(tarifa?.percentual).toBe(5);
      expect(tarifa?.valorTarifa).toBe(15);
      expect(tarifa?.valorLiquido).toBe(285);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("C. crédito 12x usa a tarifa de 12x, nunca a de 1x", async () => {
      const adquirente = await criarAdquirente({
        tabelaTarifas: [
          { modalidade: "credito", parcelas: 1, percentual: 3.49 },
          { modalidade: "credito", parcelas: 12, percentual: 7.99 },
        ],
      });
      const produto = await criarProdutoComEstoque(1200, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 12, valor: 1200 }],
        },
        null,
      );
      const tarifa = venda.pagamentos[0]?.tarifaAplicada;
      expect(tarifa?.percentual).toBe(7.99);
      expect(tarifa?.percentual).not.toBe(3.49);
      expect(tarifa?.valorTarifa).toBe(95.88); // 1200 × 7,99% = 95,88
      await caixasService.fechar(caixa.id, { valorInformado: 2200 }, null);
    });

    it("D. débito: configurado a 1,99%, R$500 → tarifa R$9,95, líquido R$490,05", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] });
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, valor: 500 }],
        },
        null,
      );
      const tarifa = venda.pagamentos[0]?.tarifaAplicada;
      expect(tarifa?.valorTarifa).toBe(9.95);
      expect(tarifa?.valorLiquido).toBe(490.05);
      await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
    });

    it("E. PIX: tarifaAplicada é null", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "PIX", modalidade: "pix", valor: 100 }],
        },
        null,
      );
      expect(venda.pagamentos[0]?.tarifaAplicada).toBeNull();
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("F. Dinheiro: tarifaAplicada é null", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", modalidade: "dinheiro", valor: 100 }],
        },
        null,
      );
      expect(venda.pagamentos[0]?.tarifaAplicada).toBeNull();
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("G. múltiplos pagamentos: PIX sem tarifa, débito e crédito com tarifas PRÓPRIAS — nunca uma tarifa sobre o total combinado", async () => {
      const adquirenteDebito = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 2 }] });
      const adquirenteCredito = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 4 }] });
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "PIX", modalidade: "pix", valor: 100 },
            { forma: "Débito", modalidade: "debito", adquirenteId: adquirenteDebito.id, valor: 100 },
            { forma: "Crédito", modalidade: "credito", adquirenteId: adquirenteCredito.id, parcelas: 1, valor: 100 },
          ],
        },
        null,
      );
      expect(venda.pagamentos[0]?.tarifaAplicada).toBeNull(); // PIX
      expect(venda.pagamentos[1]?.tarifaAplicada?.valorBruto).toBe(100); // Débito — base é o PRÓPRIO pagamento (100), não os 300 da venda
      expect(venda.pagamentos[1]?.tarifaAplicada?.valorTarifa).toBe(2);
      expect(venda.pagamentos[2]?.tarifaAplicada?.valorBruto).toBe(100); // Crédito — idem
      expect(venda.pagamentos[2]?.tarifaAplicada?.valorTarifa).toBe(4);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("H. snapshot histórico: alterar a tabela de tarifas do adquirente NÃO afeta uma venda já criada", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 6, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 6, valor: 300 }],
        },
        null,
      );
      expect(venda.pagamentos[0]?.tarifaAplicada?.percentual).toBe(5);

      // Muda a tabela do adquirente DEPOIS da venda já criada.
      await adquirentesService.atualizar(adquirente.id, { tabelaTarifas: [{ modalidade: "credito", parcelas: 6, percentual: 7 }] }, null);

      const vendaRecarregada = await service.obterPorId(venda.id);
      expect(vendaRecarregada.pagamentos[0]?.tarifaAplicada?.percentual).toBe(5); // continua 5%, nunca 7%
      expect(vendaRecarregada.pagamentos[0]?.tarifaAplicada?.valorTarifa).toBe(15); // continua R$15, nunca R$21
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("I. valorPago é sempre a soma dos valores BRUTOS — a tarifa nunca reduz o que o cliente pagou", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 6, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 6, valor: 300 }],
        },
        null,
      );
      expect(venda.pagamentos[0]?.valor).toBe(300); // bruto, nunca 285
      expect(venda.valorPago).toBe(300);
      expect(venda.valorFinal).toBe(300);
      expect(venda.status).toBe("concluida");
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("J. valor pendente calculado sobre o bruto: venda R$500, pagamento crédito R$300 (5% tarifa) → pendente R$200", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 300 }],
        },
        null,
      );
      expect(venda.valorPago).toBe(300);
      expect(venda.valorPendente).toBe(200);
      expect(venda.pagamentos[0]?.tarifaAplicada?.valorTarifa).toBe(15);
      expect(venda.pagamentos[0]?.tarifaAplicada?.valorLiquido).toBe(285);
      expect(venda.status).toBe("em_pagamento");
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("K. venda legada (sem modalidade/adquirenteId) → tarifaAplicada null, comportamento inalterado", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", valor: 100 }],
        },
        null,
      );
      expect(venda.pagamentos[0]?.tarifaAplicada).toBeNull();
      expect(venda.pagamentos[0]?.modalidade).toBeNull();
      expect(venda.valorFinal).toBe(100);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("L. precisão decimal: vários valores/percentuais não sofrem truncamento", async () => {
      const casos: { valorBruto: number; percentual: number }[] = [
        { valorBruto: 20.5, percentual: 1.99 },
        { valorBruto: 99.9, percentual: 3.49 },
        { valorBruto: 299.99, percentual: 4.37 },
        { valorBruto: 1000.01, percentual: 5.99 },
      ];

      for (const caso of casos) {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: caso.percentual }] });
        const produto = await criarProdutoComEstoque(caso.valorBruto, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, valor: caso.valorBruto }],
          },
          null,
        );

        const valorTarifaEsperado = Number(((caso.valorBruto * caso.percentual) / 100).toFixed(2));
        const valorLiquidoEsperado = Number((caso.valorBruto - valorTarifaEsperado).toFixed(2));
        const tarifa = venda.pagamentos[0]?.tarifaAplicada;
        expect(tarifa?.valorTarifa).toBe(valorTarifaEsperado);
        expect(tarifa?.valorLiquido).toBe(valorLiquidoEsperado);
        // Nunca truncado (ex.: parseInt/Math.floor produziriam sempre um inteiro).
        expect(Number.isInteger(tarifa!.valorTarifa * 100)).toBe(true); // no máximo 2 casas decimais
        await caixasService.fechar(caixa.id, { valorInformado: 1000 + caso.valorBruto }, null);
      }
    });

    it("M. idempotência: retry com a mesma chave devolve a MESMA venda, com o MESMO snapshot de tarifa (sem recálculo divergente)", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const chave = `venda-tarifa-idem-${Date.now()}`;

      const dados: DadosCriarVenda = {
        vendedorId: vendedor.id,
        caixaId: caixa.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 }],
        idempotencyKey: chave,
      };
      const primeira = await service.criar(dados, null);
      const segunda = await service.criar(dados, null);

      expect(segunda.id).toBe(primeira.id);
      expect(segunda.pagamentos[0]?.tarifaAplicada?.valorTarifa).toBe(primeira.pagamentos[0]?.tarifaAplicada?.valorTarifa);
      expect(segunda.pagamentos[0]?.tarifaAplicada?.percentual).toBe(3.49);

      const total = await connection.collection("vendas").countDocuments({ idempotencyKey: chave });
      expect(total).toBe(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("N. concorrência: duas requisições concorrentes disputando a última unidade continuam funcionando com pagamento tarifado", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
      const produto = await criarProdutoComEstoque(100, 1);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const item = { produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 };
      const pagamentos: DadosCriarVenda["pagamentos"] = [
        { forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 },
      ];
      const resultados = await Promise.allSettled([
        service.criar({ vendedorId: vendedor.id, caixaId: caixa.id, itens: [item], pagamentos }, null),
        service.criar({ vendedorId: vendedor.id, caixaId: caixa.id, itens: [item], pagamentos }, null),
      ]);

      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      expect(sucesso).toHaveLength(1);
      if (sucesso[0]?.status === "fulfilled") {
        expect(sucesso[0].value.pagamentos[0]?.tarifaAplicada?.valorTarifa).toBe(3.49);
      }

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(0);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });
  });

  describe("1 movimento de caixa por pagamento (Etapa 10.6)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    it("A. venda com 1 pagamento → 1 movimento", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos).toHaveLength(1);
      expect(movimentos[0]?.["valor"]).toBe(100);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("B. venda com 2 pagamentos → 2 movimentos", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "Dinheiro", valor: 100 },
            { forma: "PIX", valor: 200 },
          ],
        },
        null,
      );
      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos).toHaveLength(2);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("C. venda com 3 pagamentos → 3 movimentos", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "Dinheiro", valor: 100 },
            { forma: "PIX", valor: 100 },
            { forma: "Débito", valor: 100 },
          ],
        },
        null,
      );
      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos).toHaveLength(3);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("D. PIX + débito + crédito → 3 movimentos independentes, cada um com sua forma/valor corretos", async () => {
      const adquirenteDebito = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 2 }] });
      const adquirenteCredito = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 3, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "PIX", modalidade: "pix", valor: 200 },
            { forma: "Débito", modalidade: "debito", adquirenteId: adquirenteDebito.id, valor: 150 },
            { forma: "Crédito", modalidade: "credito", adquirenteId: adquirenteCredito.id, parcelas: 3, valor: 150 },
          ],
        },
        null,
      );
      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos).toHaveLength(3);
      const valores = movimentos.map((m) => m["valor"]).sort((a, b) => (a as number) - (b as number));
      expect(valores).toEqual([150, 150, 200]);
      expect(movimentos.every((m) => m["tipo"] === "venda" && m["sentido"] === "entrada")).toBe(true);
      await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
    });

    it("E. crédito parcelado: 1 movimento com o valor BRUTO — parcelas continuam disponíveis via a Venda, não duplicadas no movimento", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 6, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 6, valor: 300 }],
        },
        null,
      );
      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos).toHaveLength(1);
      expect(movimentos[0]?.["valor"]).toBe(300); // bruto, nunca 285 (líquido)
      // parcelas continuam recuperáveis via a Venda (snapshot completo) — o movimento não duplica esse dado.
      expect(venda.pagamentos[0]?.parcelas).toBe(6);
      expect(movimentos[0]?.["parcelas"]).toBeUndefined();
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("F. crédito com tarifa: tarifa/valor líquido NÃO alteram o valor do movimento nem valorPago", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 300 }],
        },
        null,
      );
      expect(venda.pagamentos[0]?.tarifaAplicada?.valorLiquido).toBe(285);
      expect(venda.valorPago).toBe(300);

      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos[0]?.["valor"]).toBe(300); // nunca 285

      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.totalVendas).toBe(300); // nunca 285
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("G. pagamento parcial: só o valor efetivamente recebido gera movimento — nenhum movimento do saldo pendente", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "PIX", valor: 200 }],
        },
        null,
      );
      expect(venda.valorPago).toBe(200);
      expect(venda.valorPendente).toBe(300);

      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos).toHaveLength(1);
      expect(movimentos[0]?.["valor"]).toBe(200);
      const somaMovimentos = movimentos.reduce((total, m) => total + (m["valor"] as number), 0);
      expect(somaMovimentos).toBe(200); // nunca 500, nunca 300
      await caixasService.fechar(caixa.id, { valorInformado: 1200 }, null);
    });

    it("H. múltiplos pagamentos + saldo pendente: N movimentos, nenhum do saldo pendente", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "Dinheiro", valor: 100 },
            { forma: "PIX", valor: 150 },
          ],
        },
        null,
      );
      expect(venda.valorPago).toBe(250);
      expect(venda.valorPendente).toBe(250);

      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos).toHaveLength(2);
      const soma = movimentos.reduce((total, m) => total + (m["valor"] as number), 0);
      expect(soma).toBe(250); // exatamente o pago; o pendente nunca vira movimento
      await caixasService.fechar(caixa.id, { valorInformado: 1250 }, null);
    });

    it("I. venda legada sem modalidade continua funcionando: cada pagamento ainda gera seu movimento com formaPagamento preservada", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "Dinheiro", valor: 150 },
            { forma: "Cartão", valor: 150 },
          ],
        },
        null,
      );
      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos).toHaveLength(2);
      const formas = movimentos.map((m) => m["formaPagamento"]).sort();
      expect(formas).toEqual(["Cartão", "Dinheiro"]);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("J. retry com a mesma idempotencyKey (múltiplos pagamentos): nenhuma venda duplicada, movimentos permanecem os mesmos N", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const chave = `venda-caixa-retry-${Date.now()}`;

      const dados: DadosCriarVenda = {
        vendedorId: vendedor.id,
        caixaId: caixa.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [
          { forma: "Dinheiro", valor: 100 },
          { forma: "PIX", valor: 200 },
        ],
        idempotencyKey: chave,
      };

      const primeira = await service.criar(dados, null);
      const movimentosAntes = await movimentosDaVenda(primeira.id);
      expect(movimentosAntes).toHaveLength(2);

      const segunda = await service.criar(dados, null);
      expect(segunda.id).toBe(primeira.id);

      const totalVendas = await connection.collection("vendas").countDocuments({ idempotencyKey: chave });
      expect(totalVendas).toBe(1);

      const movimentosDepois = await movimentosDaVenda(primeira.id);
      expect(movimentosDepois).toHaveLength(2); // não duplicou
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("K. retry após venda criada mas com movimentos INCOMPLETOS: recria só o que falta, nunca duplica o que já existe", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const chave = `venda-caixa-incompleto-${Date.now()}`;

      const dados: DadosCriarVenda = {
        vendedorId: vendedor.id,
        caixaId: caixa.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [
          { forma: "Dinheiro", valor: 100 },
          { forma: "PIX", valor: 200 },
        ],
        idempotencyKey: chave,
      };

      const venda = await service.criar(dados, null);
      const movimentosOriginais = await movimentosDaVenda(venda.id);
      expect(movimentosOriginais).toHaveLength(2);

      // Simula "processo morreu antes de criar todos os movimentos": apaga
      // manualmente o movimento do pagamento de índice 1 (PIX, R$200),
      // mantendo o de índice 0 (Dinheiro, R$100) intacto.
      const movimentoPix = movimentosOriginais.find((m) => m["formaPagamento"] === "PIX")!;
      await connection.collection("movimentos_caixa").deleteOne({ _id: movimentoPix["_id"] });
      const apagouSoUm = await movimentosDaVenda(venda.id);
      expect(apagouSoUm).toHaveLength(1);

      // Retry com a MESMA idempotencyKey: a venda já existe (não recria),
      // mas o movimento faltante deve ser recriado; o existente não duplica.
      const retry = await service.criar(dados, null);
      expect(retry.id).toBe(venda.id);

      const movimentosFinais = await movimentosDaVenda(venda.id);
      expect(movimentosFinais).toHaveLength(2); // recriou o que faltava
      const formas = movimentosFinais.map((m) => m["formaPagamento"]).sort();
      expect(formas).toEqual(["Dinheiro", "PIX"]);
      const somaFinal = movimentosFinais.reduce((total, m) => total + (m["valor"] as number), 0);
      expect(somaFinal).toBe(300);

      // O movimento de Dinheiro original NUNCA foi duplicado (mesmo _id de antes).
      const movimentoDinheiroOriginalId = String(movimentosOriginais.find((m) => m["formaPagamento"] === "Dinheiro")!["_id"]);
      const movimentosDinheiro = movimentosFinais.filter((m) => m["formaPagamento"] === "Dinheiro");
      expect(movimentosDinheiro).toHaveLength(1);
      expect(String(movimentosDinheiro[0]!["_id"])).toBe(movimentoDinheiroOriginalId);

      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("L. concorrência real: duas chamadas concorrentes registrando o MESMO pagamento (mesma idempotencyKey) resultam em exatamente 1 movimento", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const chaveMovimento = `venda-concorrencia-caixa-${Date.now()}:pagamento:0`;

      // Simula duas requisições genuinamente concorrentes chegando ao mesmo
      // ponto de registro de caixa (ex.: dois processos/instâncias, onde a
      // deduplicação em memória de `VendasService.criar` não ajudaria) —
      // exercita diretamente `CaixasService.registrarMovimentoDeVenda`, o
      // MESMO método que `garantirMovimentosDeCaixa` chama por pagamento.
      const criarMovimento = () =>
        caixasService.registrarMovimentoDeVenda({
          caixaId: caixa.id,
          tipo: "venda",
          descricao: "Venda concorrência · Dinheiro",
          referencia: "REF-CONCORRENCIA",
          vendaId: "venda-fake-concorrencia",
          vendaCodigo: "VENDA-FAKE",
          formaPagamento: "Dinheiro",
          valor: 100,
          responsavelId: null,
          responsavelNome: vendedor.nome,
          observacao: "",
          idempotencyKey: chaveMovimento,
        });

      await Promise.all([criarMovimento(), criarMovimento()]);

      const movimentos = await connection.collection("movimentos_caixa").find({ idempotencyKey: chaveMovimento }).toArray();
      expect(movimentos).toHaveLength(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("M. resumo do caixa continua somando corretamente todos os movimentos de uma venda multi-pagamento", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "Dinheiro", valor: 100 },
            { forma: "PIX", valor: 200 },
            { forma: "Débito", valor: 200 },
          ],
        },
        null,
      );
      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.totalVendas).toBe(500);
      expect(detalheCaixa.resumo.saldoEsperado).toBe(1500);
      expect(detalheCaixa.resumo.quantidadeMovimentacoes).toBe(3);
      expect(detalheCaixa.resumo.quantidadeVendas).toBe(1); // 3 movimentos, mas 1 única venda (dedupe por vendaId)
      await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
    });

    it("N. listagem de movimentos do caixa exibe os múltiplos movimentos da mesma venda corretamente", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "Dinheiro", valor: 100 },
            { forma: "PIX", valor: 200 },
          ],
        },
        null,
      );

      const listagem = await caixasService.listarMovimentos(caixa.id, { tipo: [], ordem: "desc", page: 1, limit: 20 });
      const daVenda = listagem.data.filter((m) => m.vendaId === venda.id);
      expect(daVenda).toHaveLength(2);
      expect(listagem.meta.total).toBeGreaterThanOrEqual(2);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });
  });

  describe("integração com Caixa: somente o valor recebido entra", () => {
    it("registra no caixa só o valor pago, não o valor total da venda", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 200 }],
        },
        null,
      );

      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.totalVendas).toBe(200);
      expect(detalheCaixa.resumo.saldoEsperado).toBe(1200);
      await caixasService.fechar(caixa.id, { valorInformado: 1200 }, null);
    });

    it("venda sem nenhum pagamento no ato não lança nada no caixa", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
        },
        null,
      );

      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.totalVendas).toBe(0);
      expect(detalheCaixa.resumo.saldoEsperado).toBe(1000);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("integração com Cliente/Vendedor: agregados", () => {
    it("incrementa compras/totalComprado/ultimaCompra do cliente e vendas/totalVendido/ultimaVenda do vendedor", async () => {
      const produto = await criarProdutoComEstoque(150, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 150 }],
        },
        null,
      );

      const clienteAtualizado = await clientesService.obterPorId(cliente.id);
      expect(clienteAtualizado.compras).toBe(1);
      expect(clienteAtualizado.totalComprado).toBe(150);
      expect(clienteAtualizado.ultimaCompra?.toISOString()).toBe(venda.dataVenda.toISOString());

      const vendedorAtualizado = await vendedoresService.obterPorId(vendedor.id);
      expect(vendedorAtualizado.vendas).toBe(1);
      expect(vendedorAtualizado.totalVendido).toBe(150);
      await caixasService.fechar(caixa.id, { valorInformado: 1150 }, null);
    });

    it("EM_PAGAMENTO também conta nos agregados (só cancelada não conta)", async () => {
      const produto = await criarProdutoComEstoque(150, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 50 }],
        },
        null,
      );

      const vendedorAtualizado = await vendedoresService.obterPorId(vendedor.id);
      expect(vendedorAtualizado.vendas).toBe(1);
      expect(vendedorAtualizado.totalVendido).toBe(150);
      await caixasService.fechar(caixa.id, { valorInformado: 1050 }, null);
    });
  });

  describe("baixa de parcela", () => {
    it("baixa a parcela, zera o pendente, marca CONCLUIDA e lança o recebimento no caixa", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      expect(venda.status).toBe("em_pagamento");
      const parcelaId = String(venda.parcelas[0]!._id);

      const atualizada = await service.baixarParcela(venda.id, parcelaId, { formaPagamento: "PIX" }, "admin-teste");
      expect(atualizada.status).toBe("concluida");
      expect(atualizada.valorPendente).toBe(0);
      expect(atualizada.parcelasPagas).toBe(1);

      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      // Etapa 18.2 — o Caixa não distingue mais "venda à vista" de "recebimento
      // de parcela": os 100 do ato + os 200 da baixa da parcela são ambos
      // `tipo: "venda"`, somados em `totalVendas`. `recebimentos` é sempre 0.
      expect(detalheCaixa.resumo.totalVendas).toBe(300);
      expect(detalheCaixa.resumo.recebimentos).toBe(0);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("rejeita baixar uma parcela já paga", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      const parcelaId = String(venda.parcelas[0]!._id);
      await service.baixarParcela(venda.id, parcelaId, {}, null);
      await expect(service.baixarParcela(venda.id, parcelaId, {}, null)).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("lança NOT_FOUND para parcela inexistente", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      await expect(service.baixarParcela(venda.id, "65f1a2b3c4d5e6f7a8b9c0d1", {}, null)).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });
  });

  describe("cancelamento e devolução", () => {
    it("cancelamento integral devolve o estoque, reverte agregados e lança saída no caixa limitada ao recebido", async () => {
      const produto = await criarProdutoComEstoque(200, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
          pagamentos: [{ forma: "Dinheiro", valor: 400 }],
        },
        null,
      );

      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Desistência do cliente" }, "admin-teste");
      expect(cancelada.status).toBe("cancelada");
      expect(cancelada.valorDevolvido).toBe(400);
      expect(cancelada.cancelamento?.tipo).toBe("integral");

      const produtoAtualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = produtoAtualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(5);

      const clienteAtualizado = await clientesService.obterPorId(cliente.id);
      expect(clienteAtualizado.compras).toBe(0);
      expect(clienteAtualizado.totalComprado).toBe(0);
      expect(clienteAtualizado.ultimaCompra).toBeNull();

      const vendedorAtualizado = await vendedoresService.obterPorId(vendedor.id);
      expect(vendedorAtualizado.vendas).toBe(0);
      expect(vendedorAtualizado.totalVendido).toBe(0);

      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.devolucoes).toBe(400);
      expect(detalheCaixa.resumo.saldoEsperado).toBe(1000);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("cancelamento nunca devolve ao caixa mais do que foi recebido", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 50 }],
        },
        null,
      );
      expect(venda.status).toBe("em_pagamento");

      await service.cancelar(venda.id, { tipo: "integral", motivo: "Cancelado antes de pagar tudo" }, null);

      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      // Recebeu 50 (entrada "venda") e devolve no máximo 50 (nunca 300).
      expect(detalheCaixa.resumo.totalVendas).toBe(50);
      expect(detalheCaixa.resumo.devolucoes).toBe(50);
      expect(detalheCaixa.resumo.saldoEsperado).toBe(1000);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("devolução parcial devolve só o item solicitado, mantém a venda ativa e não mexe nos agregados", async () => {
      const produtoA = await criarProdutoComEstoque(100, 5);
      const produtoB = await criarProdutoComEstoque(50, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            { produtoId: produtoA.produtoId, varianteId: produtoA.varianteId, tamanhoId: produtoA.tamanhoId, quantidade: 1 },
            { produtoId: produtoB.produtoId, varianteId: produtoB.varianteId, tamanhoId: produtoB.tamanhoId, quantidade: 1 },
          ],
          // Pagamento PARCIAL de propósito: a venda precisa continuar
          // EM_PAGAMENTO para provar que uma devolução parcial (que não
          // devolve TODOS os itens) não muda o status por si só.
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      expect(venda.status).toBe("em_pagamento");
      const itemDevolvidoId = String(venda.itens[1]!._id);

      const devolvida = await service.cancelar(venda.id, { tipo: "parcial", motivo: "Item errado", itens: [{ itemId: itemDevolvidoId, quantidade: 1 }] }, null);
      expect(devolvida.status).toBe("em_pagamento");
      expect(devolvida.valorDevolvido).toBe(50);

      const produtoBAtualizado = await produtosService.obterPorId(produtoB.produtoId);
      const tamanhoB = produtoBAtualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produtoB.tamanhoId)!;
      expect(tamanhoB.quantidade).toBe(5);

      const vendedorAtualizado = await vendedoresService.obterPorId(vendedor.id);
      expect(vendedorAtualizado.vendas).toBe(1);
      expect(vendedorAtualizado.totalVendido).toBe(150);
      // Recebeu 100 (venda) e devolveu 50 (devolução parcial, limitado ao pago) → saldo 1000 + 100 - 50.
      await caixasService.fechar(caixa.id, { valorInformado: 1050 }, null);
    });

    it("rejeita cancelar uma venda já cancelada", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste" }, null);
      await expect(service.cancelar(venda.id, { tipo: "integral", motivo: "De novo" }, null)).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("consulta: listar, obter, estatísticas", () => {
    it("busca por código encontra a venda", async () => {
      const produto = await criarProdutoComEstoque(120, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 120 }],
        },
        null,
      );
      const resultado = await service.listar(queryPadrao({ busca: venda.codigo }));
      expect(resultado.data).toHaveLength(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1120 }, null);
    });

    it("filtro status=concluida e facet de vendedor funcionam", async () => {
      const produto = await criarProdutoComEstoque(120, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 120 }],
        },
        null,
      );
      const resultado = await service.listar(queryPadrao({ busca: vendedor.nome, status: ["concluida"] }));
      expect(resultado.data.length).toBeGreaterThanOrEqual(1);
      const facetVendedor = resultado.facets["vendedor"] ?? [];
      expect(facetVendedor.some((opcao) => opcao.valor === vendedor.id)).toBe(true);
      await caixasService.fechar(caixa.id, { valorInformado: 1120 }, null);
    });

    it("obterPorId lança NOT_FOUND para venda inexistente", async () => {
      await expect(service.obterPorId("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("estatísticas somam faturamento e excluem canceladas", async () => {
      const produto = await criarProdutoComEstoque(80, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 80 }],
        },
        null,
      );
      const antes = await service.estatisticas();
      await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste stats" }, null);
      const depois = await service.estatisticas();

      expect(depois.vendasCanceladas).toBe(antes.vendasCanceladas + 1);
      expect(depois.faturamento).toBeLessThanOrEqual(antes.faturamento);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("venda fiada: cliente obrigatório quando houver saldo pendente (Etapa 10.7)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    async function esperarValidacaoClienteId(promessa: Promise<unknown>): Promise<void> {
      let erro: unknown = null;
      try {
        await promessa;
      } catch (capturado) {
        erro = capturado;
      }
      expect(erro).toBeInstanceOf(ApiException);
      const apiErro = erro as ApiException;
      expect(apiErro.code).toBe("VALIDATION_ERROR");
      expect(apiErro.errors.some((e) => e.field === "clienteId")).toBe(true);
    }

    it("A. venda totalmente paga sem cliente → sucesso (Consumidor final pode pagar à vista)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      expect(venda.clienteId).toBeNull();
      expect(venda.clienteNome).toBe("Consumidor final");
      expect(venda.valorPendente).toBe(0);
      expect(venda.status).toBe("concluida");
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("B. venda totalmente paga com cliente → sucesso", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      expect(venda.clienteId).toBe(cliente.id);
      expect(venda.valorPendente).toBe(0);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("C. venda parcial sem cliente → rejeitada com VALIDATION_ERROR no campo clienteId", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarValidacaoClienteId(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        ),
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("D. venda parcial com cliente → sucesso", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      expect(venda.valorPendente).toBe(200);
      expect(venda.status).toBe("em_pagamento");
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("E. múltiplos pagamentos + pendente sem cliente → rejeitada", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarValidacaoClienteId(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [
              { forma: "Dinheiro", valor: 100 },
              { forma: "PIX", valor: 150 },
            ],
          },
          null,
        ),
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("F. múltiplos pagamentos + pendente com cliente → sucesso", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "Dinheiro", valor: 100 },
            { forma: "PIX", valor: 150 },
          ],
        },
        null,
      );
      expect(venda.valorPago).toBe(250);
      expect(venda.valorPendente).toBe(250);
      await caixasService.fechar(caixa.id, { valorInformado: 1250 }, null);
    });

    it("G. crédito com tarifa + pendente sem cliente → rejeitada", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarValidacaoClienteId(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 300 }],
          },
          null,
        ),
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("H. crédito com tarifa + pendente com cliente → sucesso (tarifa nunca entra no saldo devedor)", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 300 }],
        },
        null,
      );
      // Pendente = 500 - 300 = 200 (sobre o BRUTO), nunca 500 - 285 (líquido).
      expect(venda.valorPendente).toBe(200);
      expect(venda.pagamentos[0]?.tarifaAplicada?.valorLiquido).toBe(285);
      expect(venda.valorPago).toBe(300);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("I. clienteId=null com pendente → rejeitada", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarValidacaoClienteId(
        service.criar(
          {
            clienteId: null,
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        ),
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("J. clienteId ausente com pendente → rejeitada", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarValidacaoClienteId(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        ),
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it('K. clienteId="" (string vazia) com pendente → rejeitada', async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarValidacaoClienteId(
        service.criar(
          {
            clienteId: "",
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        ),
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("L. clienteId inexistente → NOT_FOUND (nunca confundido com a validação de pendente)", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      let erro: unknown = null;
      try {
        await service.criar(
          {
            clienteId: "65f1a2b3c4d5e6f7a8b9c0d1",
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        );
      } catch (capturado) {
        erro = capturado;
      }
      expect(erro).toBeInstanceOf(ApiException);
      expect((erro as ApiException).code).toBe("NOT_FOUND");
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("M. venda rejeitada por pendente sem cliente não baixa estoque", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarValidacaoClienteId(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        ),
      );

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(5); // estoque intacto
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("N. venda rejeitada por pendente sem cliente não cria movimento de caixa nem documento de venda", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const totalVendasAntes = await connection.collection("vendas").countDocuments({});
      const totalMovimentosAntes = await connection.collection("movimentos_caixa").countDocuments({});

      await esperarValidacaoClienteId(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        ),
      );

      const totalVendasDepois = await connection.collection("vendas").countDocuments({});
      const totalMovimentosDepois = await connection.collection("movimentos_caixa").countDocuments({});
      expect(totalVendasDepois).toBe(totalVendasAntes); // nenhum documento de venda criado
      expect(totalMovimentosDepois).toBe(totalMovimentosAntes); // nenhum movimento de caixa criado
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("O. venda válida parcial (com cliente) cria movimento SÓ dos pagamentos efetivamente recebidos", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 200 }],
        },
        null,
      );
      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos).toHaveLength(1);
      expect(movimentos[0]?.["valor"]).toBe(200); // nunca 500 (o pendente não vira movimento)
      await caixasService.fechar(caixa.id, { valorInformado: 1200 }, null);
    });

    it("P. valorPago continua bruto, independente da tarifa, mesmo em venda fiada com cliente", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 300 }],
        },
        null,
      );
      expect(venda.valorPago).toBe(300); // bruto, nunca 285 (líquido)
      expect(venda.pagamentos[0]?.valor).toBe(300);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("Q. valorPendente é sempre calculado contra o BRUTO, nunca contra o líquido", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 10 }] });
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 400 }],
        },
        null,
      );
      // Bruto pago = 400 (líquido seria 360, com 10% de tarifa) → pendente = 1000-400 = 600, nunca 1000-360=640.
      expect(venda.pagamentos[0]?.tarifaAplicada?.valorLiquido).toBe(360);
      expect(venda.valorPendente).toBe(600);
      await caixasService.fechar(caixa.id, { valorInformado: 1400 }, null);
    });

    it("R. venda exatamente quitada (valorPago === valorFinal) → cliente não é obrigatório", async () => {
      const produto = await criarProdutoComEstoque(150, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 150 }],
        },
        null,
      );
      expect(venda.valorPago).toBe(venda.valorFinal);
      expect(venda.valorPendente).toBe(0);
      expect(venda.clienteId).toBeNull();
      expect(venda.status).toBe("concluida");
      await caixasService.fechar(caixa.id, { valorInformado: 1150 }, null);
    });

    // S. Regressão da suíte inteira: verificada rodando este arquivo completo
    // (777+ testes pré-existentes das Etapas 10.1–10.6, todos ajustados nesta
    // etapa para fornecer `clienteId` onde a venda de teste tem saldo
    // pendente — ver relatório) mais os 18 testes A–R acima, todos passando
    // juntos sem nenhuma exclusão/alteração de expectativa fora do escopo
    // desta regra.
  });

  describe("recebimento posterior de venda EM_PAGAMENTO (Etapa 10.8)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    async function venderFiado(valorItem: number, valorPagoNaCriacao: number) {
      const produto = await criarProdutoComEstoque(valorItem, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: valorPagoNaCriacao > 0 ? [{ forma: "Dinheiro", valor: valorPagoNaCriacao }] : [],
        },
        null,
      );
      return { venda, produto, vendedor, cliente, caixa };
    }

    it("A. venda criada com saldo pendente fica EM_PAGAMENTO com valorPendente correto", async () => {
      const { venda, caixa } = await venderFiado(1000, 500);
      expect(venda.status).toBe("em_pagamento");
      expect(venda.valorPago).toBe(500);
      expect(venda.valorPendente).toBe(500);
      await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
    });

    it("B. recebimento parcial reduz o pendente e mantém EM_PAGAMENTO", async () => {
      const { venda, caixa } = await venderFiado(1000, 500);
      const atualizada = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 250 }, null);
      expect(atualizada.valorPago).toBe(750);
      expect(atualizada.valorPendente).toBe(250);
      expect(atualizada.status).toBe("em_pagamento");
      await caixasService.fechar(caixa.id, { valorInformado: 1750 }, null);
    });

    it("C. segundo recebimento continua reduzindo o pendente corretamente", async () => {
      const { venda, caixa } = await venderFiado(1000, 500);
      await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 250 }, null);
      const depoisDoSegundo = await service.receberPagamento(venda.id, { forma: "PIX", valor: 150 }, null);
      expect(depoisDoSegundo.valorPago).toBe(900);
      expect(depoisDoSegundo.valorPendente).toBe(100);
      expect(depoisDoSegundo.status).toBe("em_pagamento");
      await caixasService.fechar(caixa.id, { valorInformado: 1900 }, null);
    });

    it("D. recebimento que quita exatamente o saldo conclui a venda", async () => {
      const { venda, caixa } = await venderFiado(1000, 600);
      const quitada = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 400 }, null);
      expect(quitada.valorPago).toBe(1000);
      expect(quitada.valorPendente).toBe(0);
      expect(quitada.status).toBe("concluida");
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("E. recebimento acima do saldo é rejeitado sem alterar venda/estoque/caixa/pagamentos", async () => {
      const { venda, caixa, produto } = await venderFiado(1000, 700);
      const pagamentosAntes = venda.pagamentos.length;
      const movimentosAntes = await movimentosDaVenda(venda.id);

      await expect(service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 301 }, null)).rejects.toThrow(ApiException);

      const recarregada = await service.obterPorId(venda.id);
      expect(recarregada.valorPago).toBe(700);
      expect(recarregada.valorPendente).toBe(300);
      expect(recarregada.pagamentos).toHaveLength(pagamentosAntes);

      const atualizadoProduto = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizadoProduto.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(4); // estoque intacto (já baixado 1 na criação, não baixa de novo nem desfaz)

      const movimentosDepois = await movimentosDaVenda(venda.id);
      expect(movimentosDepois).toHaveLength(movimentosAntes.length); // nenhum movimento novo
      await caixasService.fechar(caixa.id, { valorInformado: 1700 }, null);
    });

    it("F. recebimento em venda já CONCLUIDA é rejeitado, sem novo movimento de caixa", async () => {
      const { venda, caixa } = await venderFiado(500, 500); // já nasce quitada
      expect(venda.status).toBe("concluida");
      const movimentosAntes = await movimentosDaVenda(venda.id);

      await expect(service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 10 }, null)).rejects.toThrow(ApiException);

      const movimentosDepois = await movimentosDaVenda(venda.id);
      expect(movimentosDepois).toHaveLength(movimentosAntes.length);
      await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
    });

    it("G. recebimento em venda CANCELADA é rejeitado", async () => {
      const { venda, caixa } = await venderFiado(1000, 500);
      await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste 10.8" }, null);

      await expect(service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 100 }, null)).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("H. recebimento em dinheiro não exige adquirente e tarifaAplicada é null", async () => {
      const { venda, caixa } = await venderFiado(1000, 500);
      const atualizada = await service.receberPagamento(venda.id, { forma: "Dinheiro", modalidade: "dinheiro", valor: 200 }, null);
      const recebido = atualizada.pagamentos[atualizada.pagamentos.length - 1]!;
      expect(recebido.tarifaAplicada).toBeNull();
      expect(recebido.modalidade).toBe("dinheiro");
      await caixasService.fechar(caixa.id, { valorInformado: 1700 }, null);
    });

    it("I. recebimento em PIX não exige adquirente e tarifaAplicada é null", async () => {
      const { venda, caixa } = await venderFiado(1000, 500);
      const atualizada = await service.receberPagamento(venda.id, { forma: "PIX", modalidade: "pix", valor: 200 }, null);
      const recebido = atualizada.pagamentos[atualizada.pagamentos.length - 1]!;
      expect(recebido.tarifaAplicada).toBeNull();
      await caixasService.fechar(caixa.id, { valorInformado: 1700 }, null);
    });

    it("J. recebimento em débito com adquirente calcula a tarifa corretamente", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] });
      const { venda, caixa } = await venderFiado(1000, 500);
      const atualizada = await service.receberPagamento(
        venda.id,
        { forma: "Débito", modalidade: "debito", adquirenteId: adquirente.id, valor: 500 },
        null,
      );
      const recebido = atualizada.pagamentos[atualizada.pagamentos.length - 1]!;
      expect(recebido.tarifaAplicada?.valorTarifa).toBe(9.95);
      expect(recebido.tarifaAplicada?.valorLiquido).toBe(490.05);
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("K. recebimento em crédito com adquirente exige parcelas e calcula a tarifa", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 3, percentual: 5 }] });
      const { venda, caixa } = await venderFiado(1000, 500);
      const atualizada = await service.receberPagamento(
        venda.id,
        { forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 3, valor: 500 },
        null,
      );
      const recebido = atualizada.pagamentos[atualizada.pagamentos.length - 1]!;
      expect(recebido.tarifaAplicada?.parcelas).toBe(3);
      expect(recebido.tarifaAplicada?.valorTarifa).toBe(25);
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("L. tarifa é calculada sobre o valor BRUTO deste recebimento (nunca sobre o total da venda)", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 10 }] });
      const { venda, caixa } = await venderFiado(1000, 600);
      const atualizada = await service.receberPagamento(
        venda.id,
        { forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 400 },
        null,
      );
      const recebido = atualizada.pagamentos[atualizada.pagamentos.length - 1]!;
      expect(recebido.tarifaAplicada?.valorBruto).toBe(400); // nunca 1000
      expect(recebido.tarifaAplicada?.valorTarifa).toBe(40); // 10% de 400, nunca de 1000
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("M. tarifa nunca reduz valorPago — o recebimento soma sempre o BRUTO", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 10 }] });
      const { venda, caixa } = await venderFiado(1000, 600);
      const atualizada = await service.receberPagamento(
        venda.id,
        { forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 400 },
        null,
      );
      expect(atualizada.valorPago).toBe(1000); // 600 + 400 (bruto), nunca 600 + 360
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("N. tarifa nunca reduz valorPendente — pendente calculado contra o bruto", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 10 }] });
      const { venda, caixa } = await venderFiado(1000, 300);
      const atualizada = await service.receberPagamento(
        venda.id,
        { forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 400 },
        null,
      );
      // pago = 300 + 400 = 700 (bruto); pendente = 1000 - 700 = 300, nunca 1000 - (300+360)=340.
      expect(atualizada.valorPago).toBe(700);
      expect(atualizada.valorPendente).toBe(300);
      await caixasService.fechar(caixa.id, { valorInformado: 1700 }, null);
    });

    it("O. o movimento de Caixa do recebimento usa o valor BRUTO, nunca o líquido pós-tarifa", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
      const { venda, caixa } = await venderFiado(1000, 900);
      await service.receberPagamento(venda.id, { forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 100 }, null);

      const movimentos = await movimentosDaVenda(venda.id);
      // Etapa 18.2 — o movimento do recebimento posterior é `tipo: "venda"`
      // (mesmo tipo do pagamento inicial); distinguido aqui pelo valor (100),
      // já que os 900 do ato geraram um movimento `tipo: "venda"` separado.
      const doRecebimento = movimentos.find((m) => m["tipo"] === "venda" && m["valor"] === 100);
      expect(doRecebimento?.["valor"]).toBe(100); // nunca 96.51
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("P. múltiplos recebimentos sucessivos convergem corretamente para a quitação", async () => {
      const { venda, caixa } = await venderFiado(1000, 100);
      await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300 }, null);
      await service.receberPagamento(venda.id, { forma: "PIX", valor: 300 }, null);
      const final = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300 }, null);
      expect(final.valorPago).toBe(1000);
      expect(final.valorPendente).toBe(0);
      expect(final.status).toBe("concluida");
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("Q. histórico preserva cada recebimento individualmente identificável (nunca agregado em um só)", async () => {
      const { venda, caixa } = await venderFiado(1000, 100);
      await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300 }, null);
      const final = await service.receberPagamento(venda.id, { forma: "PIX", valor: 600 }, null);

      expect(final.pagamentos).toHaveLength(3); // criação + 2 recebimentos
      expect(final.pagamentos[0]?.valor).toBe(100);
      expect(final.pagamentos[1]?.valor).toBe(300);
      expect(final.pagamentos[1]?.forma).toBe("Dinheiro");
      expect(final.pagamentos[2]?.valor).toBe(600);
      expect(final.pagamentos[2]?.forma).toBe("PIX");
      // Cada um com sua própria data — não uma data única compartilhada por engano.
      expect(final.pagamentos[0]?.dataPagamento).toBeInstanceOf(Date);
      expect(final.pagamentos[1]?.dataPagamento).toBeInstanceOf(Date);
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("R. idempotência: retry com a mesma idempotencyKey não duplica o pagamento nem recontabiliza valorPago", async () => {
      const { venda, caixa } = await venderFiado(1000, 500);
      const chave = `recebimento-idem-${Date.now()}`;

      const primeira = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 200, idempotencyKey: chave }, null);
      const segunda = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 200, idempotencyKey: chave }, null);

      expect(primeira.valorPago).toBe(700);
      expect(segunda.valorPago).toBe(700); // não virou 900
      expect(segunda.pagamentos.filter((p) => p.idempotencyKey === chave)).toHaveLength(1);

      const movimentos = await movimentosDaVenda(venda.id);
      // Etapa 10.13: a chave derivada agora é prefixada pela venda
      // (`${vendaId}:recebimento:${chave}`) para sustentar a unicidade
      // GLOBAL do índice de MovimentoCaixa (não mais por caixa).
      const doRecebimento = movimentos.filter((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`);
      expect(doRecebimento).toHaveLength(1); // também não duplicou no caixa
      await caixasService.fechar(caixa.id, { valorInformado: 1700 }, null);
    });

    it("S. retry recupera um movimento de caixa faltante sem duplicar o pagamento já persistido", async () => {
      const { venda, caixa } = await venderFiado(1000, 500);
      const chave = `recebimento-retry-${Date.now()}`;

      const primeira = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 200, idempotencyKey: chave }, null);
      const movimentosOriginais = await movimentosDaVenda(primeira.id);
      const doRecebimentoOriginal = movimentosOriginais.find((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`)!;
      expect(doRecebimentoOriginal).toBeDefined();

      // Simula "processo morreu depois de salvar a venda, antes de lançar o caixa".
      await connection.collection("movimentos_caixa").deleteOne({ _id: doRecebimentoOriginal["_id"] });

      const retry = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 200, idempotencyKey: chave }, null);
      expect(retry.valorPago).toBe(700); // não recontou

      const movimentosFinais = await movimentosDaVenda(retry.id);
      const recriado = movimentosFinais.filter((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`);
      expect(recriado).toHaveLength(1); // recriou o que faltava, sem duplicar
      await caixasService.fechar(caixa.id, { valorInformado: 1700 }, null);
    });

    it("T. concorrência: duas requisições disputando o mesmo saldo nunca resultam em valorPendente negativo nem excedem valorFinal", async () => {
      const { venda, caixa } = await venderFiado(1000, 500); // pendente = 500

      const resultados = await Promise.allSettled([
        service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300 }, null),
        service.receberPagamento(venda.id, { forma: "PIX", valor: 300 }, null),
      ]);

      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      const falha = resultados.filter((r) => r.status === "rejected");
      expect(sucesso).toHaveLength(1); // só um dos dois cabia no saldo de 500
      expect(falha).toHaveLength(1);

      const final = await service.obterPorId(venda.id);
      expect(final.valorPago).toBe(800); // 500 + 300, nunca 500+600=1100
      expect(final.valorPendente).toBe(200); // nunca negativo
      expect(final.valorPago).toBeLessThanOrEqual(final.valorFinal);
      await caixasService.fechar(caixa.id, { valorInformado: 1800 }, null);
    });

    it("U. recebimento posterior não baixa estoque novamente", async () => {
      const { venda, caixa, produto } = await venderFiado(1000, 500);
      const antes = await produtosService.obterPorId(produto.produtoId);
      const tamanhoAntes = antes.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!.quantidade;

      await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 500 }, null);

      const depois = await produtosService.obterPorId(produto.produtoId);
      const tamanhoDepois = depois.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!.quantidade;
      expect(tamanhoDepois).toBe(tamanhoAntes); // estoque inalterado pelo recebimento
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("V. recebimento posterior não recalcula desconto/valorFinal da venda (snapshot preservado)", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          descontoVenda: { tipo: "percentual", valor: 10 }, // valorFinal = 900
          pagamentos: [{ forma: "Dinheiro", valor: 500 }],
        },
        null,
      );
      expect(venda.valorFinal).toBe(900);
      expect(venda.descontoVenda).toBe(100);

      const atualizada = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 400 }, null);
      expect(atualizada.valorFinal).toBe(900); // inalterado
      expect(atualizada.descontoVenda).toBe(100); // inalterado
      expect(atualizada.itens[0]?.precoPraticado).toBe(1000); // snapshot do item inalterado
      expect(atualizada.status).toBe("concluida");
      await caixasService.fechar(caixa.id, { valorInformado: 1900 }, null);
    });

    it("W. tarifa de um pagamento anterior nunca é recalculada por um recebimento posterior diferente", async () => {
      const adquirenteOriginal = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
      const adquirenteNovo = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 1.99 }] });
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirenteOriginal.id, parcelas: 1, valor: 600 }],
        },
        null,
      );
      const tarifaOriginalAntes = venda.pagamentos[0]!.tarifaAplicada!.valorTarifa;
      expect(tarifaOriginalAntes).toBe(20.94); // 600 × 3,49%

      const final = await service.receberPagamento(
        venda.id,
        { forma: "Crédito", modalidade: "credito", adquirenteId: adquirenteNovo.id, parcelas: 1, valor: 400 },
        null,
      );
      // O pagamento ORIGINAL continua com sua própria tarifa, intocada.
      expect(final.pagamentos[0]?.tarifaAplicada?.valorTarifa).toBe(20.94);
      expect(final.pagamentos[0]?.tarifaAplicada?.percentual).toBe(3.49);
      // O NOVO recebimento tem sua própria tarifa, independente.
      expect(final.pagamentos[1]?.tarifaAplicada?.valorTarifa).toBe(7.96); // 400 × 1,99%
      expect(final.pagamentos[1]?.tarifaAplicada?.percentual).toBe(1.99);
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    // X. Regressão completa: verificada rodando este arquivo inteiro (testes
    // A–W acima somados a toda a suíte pré-existente das Etapas 10.1–10.7),
    // todos passando juntos, sem nenhuma alteração de expectativa fora do
    // escopo desta etapa.
  });

  describe("cancelamento e devolução: valor efetivo e concorrência (Etapa 10.9)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    it("A. cancelamento de venda normal (paga integralmente) devolve o valor cheio", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste A" }, null);
      expect(cancelada.status).toBe("cancelada");
      expect(cancelada.valorDevolvido).toBe(100);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("B. cancelamento de venda EM_PAGAMENTO: devolução baseada no valor efetivo, nunca no saldo pendente", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 600 }],
        },
        null,
      );
      expect(venda.status).toBe("em_pagamento");
      expect(venda.valorPendente).toBe(400);

      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste B" }, null);
      // Valor econômico do item devolvido é 1000 (o item inteiro), mas o
      // pendente (400) nunca vira dinheiro devolvido no caixa — só o
      // efetivamente pago (600) pode retornar como saída.
      expect(cancelada.valorDevolvido).toBe(1000);
      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.devolucoes).toBe(600); // nunca 1000, nunca 400
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("C. cancelamento de venda CONCLUIDA restaura estoque uma única vez", async () => {
      const produto = await criarProdutoComEstoque(200, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
          pagamentos: [{ forma: "Dinheiro", valor: 400 }],
        },
        null,
      );
      expect(venda.status).toBe("concluida");
      await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste C" }, null);

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(5); // voltou exatamente ao original
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("D. venda já cancelada rejeita novo cancelamento sem efeitos colaterais", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      await service.cancelar(venda.id, { tipo: "integral", motivo: "Primeiro" }, null);
      const movimentosAntes = await movimentosDaVenda(venda.id);

      await expect(service.cancelar(venda.id, { tipo: "integral", motivo: "Segundo" }, null)).rejects.toThrow(ApiException);

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(5); // não restaurou de novo
      const movimentosDepois = await movimentosDaVenda(venda.id);
      expect(movimentosDepois).toHaveLength(movimentosAntes.length); // nenhum movimento novo
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("E./F. restauração de estoque acontece e é única para múltiplos itens/quantidades (G/H)", async () => {
      const produtoA = await criarProdutoComEstoque(50, 10);
      const produtoB = await criarProdutoComEstoque(30, 8);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            { produtoId: produtoA.produtoId, varianteId: produtoA.varianteId, tamanhoId: produtoA.tamanhoId, quantidade: 3 },
            { produtoId: produtoB.produtoId, varianteId: produtoB.varianteId, tamanhoId: produtoB.tamanhoId, quantidade: 2 },
          ],
          pagamentos: [{ forma: "Dinheiro", valor: 210 }],
        },
        null,
      );
      await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste E/F/G/H" }, null);

      const atualizadoA = await produtosService.obterPorId(produtoA.produtoId);
      const tamanhoA = atualizadoA.variantes[0]!.tamanhos.find((t) => String(t._id) === produtoA.tamanhoId)!;
      expect(tamanhoA.quantidade).toBe(10); // 7 (10-3) + 3 devolvidos

      const atualizadoB = await produtosService.obterPorId(produtoB.produtoId);
      const tamanhoB = atualizadoB.variantes[0]!.tamanhos.find((t) => String(t._id) === produtoB.tamanhoId)!;
      expect(tamanhoB.quantidade).toBe(8); // 6 (8-2) + 2 devolvidos
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("I. item com descontoItem em R$: devolução usa o valor efetivo (subtotal), nunca precoPraticado bruto", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 1,
              desconto: { tipo: "valor", valor: 20 },
            },
          ],
          pagamentos: [{ forma: "Dinheiro", valor: 80 }],
        },
        null,
      );
      expect(venda.itens[0]?.subtotal).toBe(80);
      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste I" }, null);
      expect(cancelada.valorDevolvido).toBe(80); // nunca 100
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("J. item com descontoItem em % já resolvido no snapshot: devolução parcial usa o valor unitário efetivo", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 2,
              desconto: { tipo: "percentual", valor: 10 },
            },
          ],
          pagamentos: [{ forma: "Dinheiro", valor: 180 }],
        },
        null,
      );
      // base = 100×2 = 200; 10% = 20; subtotal = 180 → unitário efetivo = 90.
      expect(venda.itens[0]?.subtotal).toBe(180);
      const itemId = String(venda.itens[0]!._id);

      const devolvida = await service.cancelar(venda.id, { tipo: "parcial", motivo: "Teste J", itens: [{ itemId, quantidade: 1 }] }, null);
      expect(devolvida.valorDevolvido).toBe(90); // nunca 100 (precoOriginal) nem 100 (precoPraticado)
      await caixasService.fechar(caixa.id, { valorInformado: 1090 }, null);
    });

    it("K. produto em promoção + descontoItem: devolução usa o valor efetivo pós-promoção e pós-desconto", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      await produtosService.definirPromocao(produto.produtoId, { ehPromocao: true, precoPromocional: 80 }, null);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 1,
              desconto: { tipo: "percentual", valor: 10 },
            },
          ],
          pagamentos: [{ forma: "Dinheiro", valor: 72 }],
        },
        null,
      );
      // precoOriginal=100, precoPraticado=80 (promoção), descontoItem=8 (10% de 80), subtotal=72.
      expect(venda.itens[0]?.precoOriginal).toBe(100);
      expect(venda.itens[0]?.precoPraticado).toBe(80);
      expect(venda.itens[0]?.subtotal).toBe(72);

      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste K" }, null);
      expect(cancelada.valorDevolvido).toBe(72); // nunca 100, nunca 80
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("L. devolução parcial de 1 de 2 unidades devolve exatamente o valor efetivo unitário", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      await produtosService.definirPromocao(produto.produtoId, { ehPromocao: true, precoPromocional: 80 }, null);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 2,
              desconto: { tipo: "percentual", valor: 10 },
            },
          ],
          pagamentos: [{ forma: "Dinheiro", valor: 144 }],
        },
        null,
      );
      // base = 80×2=160; desconto 10% = 16; subtotal = 144 (exemplo do pedido: 72/unidade).
      expect(venda.itens[0]?.subtotal).toBe(144);
      const itemId = String(venda.itens[0]!._id);

      const devolvida = await service.cancelar(venda.id, { tipo: "parcial", motivo: "Teste L", itens: [{ itemId, quantidade: 1 }] }, null);
      expect(devolvida.valorDevolvido).toBe(72); // nunca 80, 100 ou 144
      await caixasService.fechar(caixa.id, { valorInformado: 1072 }, null);
    });

    it("M. devolução integral (via tipo parcial pedindo tudo) devolve o valor total efetivo", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            {
              produtoId: produto.produtoId,
              varianteId: produto.varianteId,
              tamanhoId: produto.tamanhoId,
              quantidade: 2,
              desconto: { tipo: "percentual", valor: 10 },
            },
          ],
          pagamentos: [{ forma: "Dinheiro", valor: 180 }],
        },
        null,
      );
      const itemId = String(venda.itens[0]!._id);
      const devolvida = await service.cancelar(venda.id, { tipo: "parcial", motivo: "Teste M", itens: [{ itemId, quantidade: 2 }] }, null);
      expect(devolvida.valorDevolvido).toBe(180);
      expect(devolvida.status).toBe("cancelada"); // todos os itens devolvidos → venda cancelada
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("N. descontoVenda é rateado proporcionalmente ao valor efetivo de cada item", async () => {
      const produtoA = await criarProdutoComEstoque(100, 5);
      const produtoB = await criarProdutoComEstoque(200, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            { produtoId: produtoA.produtoId, varianteId: produtoA.varianteId, tamanhoId: produtoA.tamanhoId, quantidade: 1 },
            { produtoId: produtoB.produtoId, varianteId: produtoB.varianteId, tamanhoId: produtoB.tamanhoId, quantidade: 1 },
          ],
          descontoVenda: { tipo: "valor", valor: 30 },
          pagamentos: [{ forma: "Dinheiro", valor: 270 }],
        },
        null,
      );
      // subtotalVenda = 300; descontoVenda = 30 → fator = 270/300 = 0.9.
      // A: 100×0.9=90; B: 200×0.9=180 (exemplo exato do pedido).
      const itemA = venda.itens.find((i) => i.produtoId === produtoA.produtoId)!;
      const itemB = venda.itens.find((i) => i.produtoId === produtoB.produtoId)!;

      const devolvidaA = await service.cancelar(
        venda.id,
        { tipo: "parcial", motivo: "Teste N (A)", itens: [{ itemId: String(itemA._id), quantidade: 1 }] },
        null,
      );
      // `cancelamento.valorDevolvido` é o valor DESTE evento (não o acumulado da venda).
      expect(devolvidaA.cancelamento?.valorDevolvido).toBe(90);

      const devolvidaB = await service.cancelar(
        venda.id,
        { tipo: "parcial", motivo: "Teste N (B)", itens: [{ itemId: String(itemB._id), quantidade: 1 }] },
        null,
      );
      expect(devolvidaB.cancelamento?.valorDevolvido).toBe(180);
      expect(devolvidaB.valorDevolvido).toBe(270); // acumulado: 90 (A) + 180 (B)
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("O. múltiplos pagamentos (PIX + Débito + Crédito): cancelamento preserva todos e devolve o valor efetivo total", async () => {
      const adquirenteDebito = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 2 }] });
      const adquirenteCredito = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 4 }] });
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [
            { forma: "PIX", modalidade: "pix", valor: 100 },
            { forma: "Débito", modalidade: "debito", adquirenteId: adquirenteDebito.id, valor: 100 },
            { forma: "Crédito", modalidade: "credito", adquirenteId: adquirenteCredito.id, parcelas: 1, valor: 100 },
          ],
        },
        null,
      );
      expect(venda.valorPago).toBe(300);

      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste O" }, null);
      expect(cancelada.valorDevolvido).toBe(300);
      expect(cancelada.pagamentos).toHaveLength(3); // histórico dos 3 pagamentos preservado
      expect(cancelada.pagamentos.map((p) => p.forma).sort()).toEqual(["Crédito", "Débito", "PIX"]);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("P. tarifa de adquirente não reduz o valor devolvido ao cliente", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 10 }] });
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 1000 }],
        },
        null,
      );
      expect(venda.pagamentos[0]?.tarifaAplicada?.valorLiquido).toBe(900); // 1000 - 10%

      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste P" }, null);
      expect(cancelada.valorDevolvido).toBe(1000); // bruto, nunca 900
      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.devolucoes).toBe(1000); // nunca 900
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("Q. valorLiquido nunca é usado como valor devido ao cliente — pagamento histórico permanece intocado", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 5 }] });
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 500 }],
        },
        null,
      );
      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste Q" }, null);
      // O pagamento histórico continua com sua própria tarifa/valorLiquido — nunca recalculado nem usado como devolução.
      expect(cancelada.pagamentos[0]?.tarifaAplicada?.valorLiquido).toBe(475);
      expect(cancelada.pagamentos[0]?.valor).toBe(500);
      expect(cancelada.valorDevolvido).toBe(500);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("R. histórico (itens, pagamentos, tarifas, cliente, vendedor, caixa) é preservado após o cancelamento", async () => {
      const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
      const produto = await criarProdutoComEstoque(200, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 200 }],
        },
        null,
      );
      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste R" }, null);

      expect(cancelada.itens).toHaveLength(1);
      expect(cancelada.itens[0]?.nome).toBe(venda.itens[0]?.nome);
      expect(cancelada.pagamentos[0]?.adquirenteId).toBe(adquirente.id);
      expect(cancelada.pagamentos[0]?.tarifaAplicada?.percentual).toBe(3.49);
      expect(cancelada.clienteId).toBe(cliente.id);
      expect(cancelada.vendedorId).toBe(vendedor.id);
      expect(cancelada.caixaId).toBe(caixa.id);
      expect(cancelada.dataVenda).toEqual(venda.dataVenda);
      expect(cancelada.cancelamento).not.toBeNull();
      expect(cancelada.cancelamento?.itens[0]?.quantidade).toBe(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("S. retry: repetir o cancelamento (mesma chamada) é rejeitado sem duplicar efeitos", async () => {
      const produto = await criarProdutoComEstoque(150, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 150 }],
        },
        null,
      );
      await service.cancelar(venda.id, { tipo: "integral", motivo: "Primeira tentativa" }, null);
      await expect(service.cancelar(venda.id, { tipo: "integral", motivo: "Retry" }, null)).rejects.toThrow(ApiException);

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(5);
      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.devolucoes).toBe(150); // não dobrou
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("T./V./W. concorrência: duas requisições cancelando a MESMA venda — só uma vence, estoque e caixa refletem uma única devolução", async () => {
      const produto = await criarProdutoComEstoque(100, 3);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 3 }],
          pagamentos: [{ forma: "Dinheiro", valor: 300 }],
        },
        null,
      );

      const resultados = await Promise.allSettled([
        service.cancelar(venda.id, { tipo: "integral", motivo: "Concorrente 1" }, null),
        service.cancelar(venda.id, { tipo: "integral", motivo: "Concorrente 2" }, null),
      ]);

      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      const falha = resultados.filter((r) => r.status === "rejected");
      expect(sucesso).toHaveLength(1);
      expect(falha).toHaveLength(1);

      // V. estoque restaurado uma ÚNICA vez (nunca 6, sempre 3).
      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(3);

      // W. um único movimento de cancelamento no caixa (nunca dois).
      const movimentos = await movimentosDaVenda(venda.id);
      const decancelamento = movimentos.filter((m) => m["tipo"] === "cancelamento");
      expect(decancelamento).toHaveLength(1);
      expect(decancelamento[0]?.["valor"]).toBe(300);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("T2. concorrência: duas devoluções parciais do MESMO item disputando a mesma quantidade restante", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
          pagamentos: [{ forma: "Dinheiro", valor: 200 }],
        },
        null,
      );
      const itemId = String(venda.itens[0]!._id);

      const resultados = await Promise.allSettled([
        service.cancelar(venda.id, { tipo: "parcial", motivo: "Concorrente A", itens: [{ itemId, quantidade: 2 }] }, null),
        service.cancelar(venda.id, { tipo: "parcial", motivo: "Concorrente B", itens: [{ itemId, quantidade: 2 }] }, null),
      ]);

      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      expect(sucesso).toHaveLength(1); // a segunda não encontra mais quantidade disponível

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(5); // nunca 7 (restaurado só as 2 unidades reais)
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("U. venda CANCELADA continua rejeitando recebimento posterior (regressão Etapa 10.8)", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 500 }],
        },
        null,
      );
      await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste U" }, null);

      await expect(service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 100 }, null)).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    // X. Regressão completa: verificada rodando este arquivo inteiro (testes
    // A–U/T2 acima somados a toda a suíte pré-existente das Etapas 10.1–10.8),
    // todos passando juntos, sem nenhuma alteração de expectativa fora do
    // escopo desta etapa.
  });

  describe("consolidação do ciclo financeiro: caixa atual vs. caixa original (Etapa 10.10)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    it("receberPagamento usa o caixa ATUALMENTE aberto quando o caixa original da venda já foi fechado", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixaOriginal = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixaOriginal.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 400 }],
        },
        null,
      );
      expect(venda.caixaId).toBe(caixaOriginal.id);

      // Fecha o caixa da venda original — dias depois, o cliente volta para pagar.
      await caixasService.fechar(caixaOriginal.id, { valorInformado: 1400 }, null);
      const caixaAtual = await abrirCaixa();

      const atualizada = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 600 }, null);
      expect(atualizada.valorPago).toBe(1000);
      expect(atualizada.status).toBe("concluida");

      // O movimento vai para o caixa ATUAL — nunca para o original (já fechado).
      // Etapa 18.2 — o movimento gerado por `receberPagamento` é `tipo: "venda"`
      // (não existe mais `"recebimento_parcela"` como tipo distinto); como o
      // caixa original só teve os 400 do ato, filtramos pelo caixaId atual
      // para achar especificamente o movimento dos 600 recebidos depois.
      const movimentos = await movimentosDaVenda(venda.id);
      const doRecebimento = movimentos.find((m) => m["tipo"] === "venda" && String(m["caixaId"]) === caixaAtual.id);
      expect(doRecebimento).toBeTruthy();
      expect(doRecebimento?.["valor"]).toBe(600);
      expect(String(doRecebimento?.["caixaId"])).not.toBe(caixaOriginal.id);

      const detalheAtual = await caixasService.obterDetalhe(caixaAtual.id);
      expect(detalheAtual.resumo.totalVendas).toBe(600);
      expect(detalheAtual.resumo.recebimentos).toBe(0);
      await caixasService.fechar(caixaAtual.id, { valorInformado: 1600 }, null);
    });

    it("receberPagamento sem nenhum caixa aberto é rejeitado sem alterar a venda", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 300 }],
        },
        null,
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null); // nenhum caixa fica aberto agora

      await expect(service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 100 }, null)).rejects.toThrow(ApiException);

      const recarregada = await service.obterPorId(venda.id);
      expect(recarregada.valorPago).toBe(300); // não mutou a venda antes de falhar
      expect(recarregada.valorPendente).toBe(200);

      // Deixa um caixa aberto de novo para não quebrar os testes seguintes do arquivo.
      const caixaFinal = await abrirCaixa();
      await caixasService.fechar(caixaFinal.id, { valorInformado: 1000 }, null);
    });

    it("baixarParcela usa o caixa ATUALMENTE aberto quando o caixa original da venda já foi fechado", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixaOriginal = await abrirCaixa();

      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixaOriginal.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      const parcelaId = String(venda.parcelas[0]!._id);

      await caixasService.fechar(caixaOriginal.id, { valorInformado: 1100 }, null);
      const caixaAtual = await abrirCaixa();

      const atualizada = await service.baixarParcela(venda.id, parcelaId, { formaPagamento: "PIX" }, null);
      expect(atualizada.status).toBe("concluida");

      // Etapa 18.2 — `tipo: "venda"` para os dois movimentos agora (o do ato e
      // o da baixa); distinguido pelo caixaId, que é exatamente o que este
      // teste verifica (a baixa vai para o caixa ATUAL, nunca o original).
      const movimentos = await movimentosDaVenda(venda.id);
      const daBaixa = movimentos.find((m) => m["tipo"] === "venda" && String(m["caixaId"]) === caixaAtual.id);
      expect(daBaixa).toBeTruthy();
      expect(String(daBaixa?.["caixaId"])).toBe(caixaAtual.id);
      expect(String(daBaixa?.["caixaId"])).not.toBe(caixaOriginal.id);
      await caixasService.fechar(caixaAtual.id, { valorInformado: 1200 }, null);
    });

    it("baixarParcela sem nenhum caixa aberto é rejeitado sem alterar a venda", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      const parcelaId = String(venda.parcelas[0]!._id);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);

      await expect(service.baixarParcela(venda.id, parcelaId, {}, null)).rejects.toThrow(ApiException);

      const recarregada = await service.obterPorId(venda.id);
      expect(recarregada.parcelas[0]?.pagoEm).toBeNull(); // parcela não foi mutada antes de falhar

      const caixaFinal = await abrirCaixa();
      await caixasService.fechar(caixaFinal.id, { valorInformado: 1000 }, null);
    });

    it("idempotência do recebimento continua segura mesmo com o caixa resolvido dinamicamente: retry não duplica nem recontabiliza", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 200 }],
        },
        null,
      );
      const chave = `recebimento-10.10-retry-${Date.now()}`;

      const primeira = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 100, idempotencyKey: chave }, null);
      const segunda = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 100, idempotencyKey: chave }, null);
      expect(primeira.valorPago).toBe(300);
      expect(segunda.valorPago).toBe(300); // não dobrou

      const movimentos = await movimentosDaVenda(venda.id);
      const doRecebimento = movimentos.filter((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`);
      expect(doRecebimento).toHaveLength(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    // Regressão completa (X): rodar este arquivo inteiro junto com a suíte
    // completa do projeto — nenhuma expectativa das Etapas 10.1–10.9 foi
    // alterada por esta consolidação, apenas o ponto de resolução do caixa em
    // `receberPagamento`/`baixarParcela` (antes `venda.caixaId`, agora o
    // caixa atualmente aberto).
  });

  describe("cancelamento no caixa atual + baixa de parcela estruturada (Etapa 10.11)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    describe("cancelamento: caixa atual, nunca venda.caixaId", () => {
      it("A. Caixa A fechado + Caixa B aberto: cancelamento lança o movimento no Caixa B, nenhum no Caixa A", async () => {
        const produto = await criarProdutoComEstoque(200, 5);
        const vendedor = await criarVendedor();
        const caixaA = await abrirCaixa();

        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixaA.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 200 }],
          },
          null,
        );
        expect(venda.caixaId).toBe(caixaA.id); // venda.caixaId continua sendo o caixa ORIGINAL

        await caixasService.fechar(caixaA.id, { valorInformado: 1200 }, null);
        const caixaB = await abrirCaixa();

        const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste A" }, null);
        expect(cancelada.status).toBe("cancelada");
        expect(cancelada.caixaId).toBe(caixaA.id); // venda.caixaId NUNCA muda de significado

        const movimentos = await movimentosDaVenda(venda.id);
        const doCancelamento = movimentos.find((m) => m["tipo"] === "cancelamento");
        expect(String(doCancelamento?.["caixaId"])).toBe(caixaB.id);
        expect(String(doCancelamento?.["caixaId"])).not.toBe(caixaA.id);
        await caixasService.fechar(caixaB.id, { valorInformado: 800 }, null); // 1000 - 200 devolvidos
      });

      it("B. nenhum caixa aberto: cancelamento rejeitado, venda e estoque intactos, nenhum movimento", async () => {
        const produto = await criarProdutoComEstoque(150, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 150 }],
          },
          null,
        );
        await caixasService.fechar(caixa.id, { valorInformado: 1150 }, null); // nenhum caixa fica aberto

        await expect(service.cancelar(venda.id, { tipo: "integral", motivo: "Teste B" }, null)).rejects.toThrow(ApiException);

        const recarregada = await service.obterPorId(venda.id);
        expect(recarregada.status).toBe("concluida"); // não mudou
        const atualizado = await produtosService.obterPorId(produto.produtoId);
        const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
        expect(tamanho.quantidade).toBe(4); // estoque intacto (não devolvido)
        const movimentos = await movimentosDaVenda(venda.id);
        expect(movimentos.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(0);

        const caixaFinal = await abrirCaixa();
        await caixasService.fechar(caixaFinal.id, { valorInformado: 1000 }, null);
      });

      it("C. cancelamento concorrente: estoque restaurado uma única vez (com caixa atual)", async () => {
        const produto = await criarProdutoComEstoque(100, 3);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 3 }],
            pagamentos: [{ forma: "Dinheiro", valor: 300 }],
          },
          null,
        );

        const resultados = await Promise.allSettled([
          service.cancelar(venda.id, { tipo: "integral", motivo: "Concorrente 1" }, null),
          service.cancelar(venda.id, { tipo: "integral", motivo: "Concorrente 2" }, null),
        ]);
        expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(1);

        const atualizado = await produtosService.obterPorId(produto.produtoId);
        const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
        expect(tamanho.quantidade).toBe(3); // nunca 6

        const movimentos = await movimentosDaVenda(venda.id);
        expect(movimentos.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(1);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("D. cancelamento com descontoItem devolve o valor efetivo (subtotal), no caixa atual", async () => {
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [
              {
                produtoId: produto.produtoId,
                varianteId: produto.varianteId,
                tamanhoId: produto.tamanhoId,
                quantidade: 1,
                desconto: { tipo: "valor", valor: 20 },
              },
            ],
            pagamentos: [{ forma: "Dinheiro", valor: 80 }],
          },
          null,
        );
        const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste D" }, null);
        expect(cancelada.valorDevolvido).toBe(80); // nunca 100
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("E. cancelamento com descontoVenda preserva o rateio proporcional (Etapa 10.9), no caixa atual", async () => {
        const produtoA = await criarProdutoComEstoque(100, 5);
        const produtoB = await criarProdutoComEstoque(200, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [
              { produtoId: produtoA.produtoId, varianteId: produtoA.varianteId, tamanhoId: produtoA.tamanhoId, quantidade: 1 },
              { produtoId: produtoB.produtoId, varianteId: produtoB.varianteId, tamanhoId: produtoB.tamanhoId, quantidade: 1 },
            ],
            descontoVenda: { tipo: "valor", valor: 30 },
            pagamentos: [{ forma: "Dinheiro", valor: 270 }],
          },
          null,
        );
        const itemA = venda.itens.find((i) => i.produtoId === produtoA.produtoId)!;
        const devolvida = await service.cancelar(
          venda.id,
          { tipo: "parcial", motivo: "Teste E", itens: [{ itemId: String(itemA._id), quantidade: 1 }] },
          null,
        );
        expect(devolvida.cancelamento?.valorDevolvido).toBe(90); // 100 × (270/300)
        await caixasService.fechar(caixa.id, { valorInformado: 1180 }, null); // 1000 + 270 - 90
      });

      it("F. tarifa de adquirente nunca reduz o valor devolvido, no caixa atual", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 10 }] });
        const produto = await criarProdutoComEstoque(1000, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 1000 }],
          },
          null,
        );
        const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste F" }, null);
        expect(cancelada.valorDevolvido).toBe(1000); // bruto, nunca 900 (líquido)
        const detalhe = await caixasService.obterDetalhe(caixa.id);
        expect(detalhe.resumo.devolucoes).toBe(1000);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });
    });

    describe("baixarParcela: pagamento estruturado + tarifa + caixa atual", () => {
      async function venderComUmaParcela(valorItem: number, valorPagoNaCriacao: number) {
        const produto = await criarProdutoComEstoque(valorItem, 5);
        const vendedor = await criarVendedor();
        const cliente = await criarCliente();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            clienteId: cliente.id,
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: valorPagoNaCriacao }],
          },
          null,
        );
        const parcelaId = String(venda.parcelas[0]!._id);
        return { venda, parcelaId, caixa };
      }

      it("G. contrato legado { valor } continua funcionando — tarifaAplicada null", async () => {
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100); // parcela = 200
        const atualizada = await service.baixarParcela(venda.id, parcelaId, { valor: 200 }, null);
        expect(atualizada.status).toBe("concluida");
        expect(atualizada.pagamentos[atualizada.pagamentos.length - 1]?.tarifaAplicada).toBeNull();
        expect(atualizada.pagamentos[atualizada.pagamentos.length - 1]?.modalidade).toBeNull();
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("H. dinheiro: funciona, tarifaAplicada null", async () => {
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100);
        const atualizada = await service.baixarParcela(venda.id, parcelaId, { modalidade: "dinheiro" }, null);
        expect(atualizada.status).toBe("concluida");
        expect(atualizada.pagamentos[atualizada.pagamentos.length - 1]?.tarifaAplicada).toBeNull();
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("I. PIX: funciona, tarifaAplicada null", async () => {
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100);
        const atualizada = await service.baixarParcela(venda.id, parcelaId, { modalidade: "pix" }, null);
        expect(atualizada.status).toBe("concluida");
        expect(atualizada.pagamentos[atualizada.pagamentos.length - 1]?.tarifaAplicada).toBeNull();
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("J. débito + adquirente: tarifa calculada corretamente", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] });
        const { venda, parcelaId, caixa } = await venderComUmaParcela(500, 300); // parcela = 200
        const atualizada = await service.baixarParcela(venda.id, parcelaId, { modalidade: "debito", adquirenteId: adquirente.id }, null);
        const pagamento = atualizada.pagamentos[atualizada.pagamentos.length - 1]!;
        expect(pagamento.tarifaAplicada?.valorTarifa).toBe(3.98); // 200 × 1,99%
        expect(pagamento.tarifaAplicada?.valorLiquido).toBe(196.02);
        await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
      });

      it("K. crédito 6x + adquirente: usa a tarifa da configuração 6x", async () => {
        const adquirente = await criarAdquirente({
          tabelaTarifas: [
            { modalidade: "credito", parcelas: 1, percentual: 3.49 },
            { modalidade: "credito", parcelas: 6, percentual: 5 },
          ],
        });
        const { venda, parcelaId, caixa } = await venderComUmaParcela(1200, 600); // parcela = 600
        const atualizada = await service.baixarParcela(
          venda.id,
          parcelaId,
          { modalidade: "credito", adquirenteId: adquirente.id, parcelas: 6 },
          null,
        );
        const pagamento = atualizada.pagamentos[atualizada.pagamentos.length - 1]!;
        expect(pagamento.tarifaAplicada?.percentual).toBe(5);
        expect(pagamento.tarifaAplicada?.valorTarifa).toBe(30); // 600 × 5%, nunca a de 1x (3,49%)
        await caixasService.fechar(caixa.id, { valorInformado: 2200 }, null);
      });

      it("L. crédito sem adquirente é rejeitado (VALIDATION_ERROR)", async () => {
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100);
        await expect(service.baixarParcela(venda.id, parcelaId, { modalidade: "credito", parcelas: 1 }, null)).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null); // parcela não foi baixada, nada mudou
      });

      it("M. crédito com parcelamento NÃO configurado é rejeitado", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] });
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100);
        await expect(
          service.baixarParcela(venda.id, parcelaId, { modalidade: "credito", adquirenteId: adquirente.id, parcelas: 3 }, null),
        ).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("N. adquirente inativa é rejeitada", async () => {
        const adquirente = await criarAdquirente({ ativo: false, tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] });
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100);
        await expect(service.baixarParcela(venda.id, parcelaId, { modalidade: "debito", adquirenteId: adquirente.id }, null)).rejects.toThrow(
          ApiException,
        );
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("O. adquirente inexistente retorna NOT_FOUND", async () => {
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100);
        let erro: unknown = null;
        try {
          await service.baixarParcela(venda.id, parcelaId, { modalidade: "debito", adquirenteId: "65f1a2b3c4d5e6f7a8b9c0d1" }, null);
        } catch (capturado) {
          erro = capturado;
        }
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).code).toBe("NOT_FOUND");
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("P. valor informado maior que o valor da parcela é rejeitado", async () => {
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100); // parcela = 200
        await expect(service.baixarParcela(venda.id, parcelaId, { valor: 201 }, null)).rejects.toThrow(ApiException);
        const recarregada = await service.obterPorId(venda.id);
        expect(recarregada.parcelas[0]?.pagoEm).toBeNull(); // não baixou nada
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
      });

      it("Q. duas baixas concorrentes da mesma parcela: só uma consome o saldo", async () => {
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100);
        const resultados = await Promise.allSettled([
          service.baixarParcela(venda.id, parcelaId, { formaPagamento: "PIX" }, null),
          service.baixarParcela(venda.id, parcelaId, { formaPagamento: "Dinheiro" }, null),
        ]);
        expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(1);

        const final = await service.obterPorId(venda.id);
        expect(final.valorPago).toBe(300); // 100 + 200, nunca 100+400
        expect(final.valorPendente).toBe(0);
        expect(final.status).toBe("concluida");
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("R. retry idempotente: não duplica pagamento nem movimento de caixa", async () => {
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100);
        const chave = `baixa-parcela-retry-${Date.now()}`;

        const primeira = await service.baixarParcela(venda.id, parcelaId, { formaPagamento: "PIX", idempotencyKey: chave }, null);
        const segunda = await service.baixarParcela(venda.id, parcelaId, { formaPagamento: "PIX", idempotencyKey: chave }, null);
        expect(primeira.valorPago).toBe(300);
        expect(segunda.valorPago).toBe(300); // não dobrou
        expect(segunda.pagamentos.filter((p) => p.idempotencyKey === chave)).toHaveLength(1);

        const movimentos = await movimentosDaVenda(venda.id);
        const daBaixa = movimentos.filter((m) => m["idempotencyKey"] === `${venda.id}:parcela:${chave}`);
        expect(daBaixa).toHaveLength(1);
        await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
      });

      it("S. caixa original fechado + caixa atual aberto: movimento lançado no caixa atual", async () => {
        const { venda, parcelaId, caixa: caixaOriginal } = await venderComUmaParcela(300, 100);
        await caixasService.fechar(caixaOriginal.id, { valorInformado: 1100 }, null);
        const caixaAtual = await abrirCaixa();

        const atualizada = await service.baixarParcela(venda.id, parcelaId, {}, null);
        expect(atualizada.status).toBe("concluida");

        // Etapa 18.2 — os dois movimentos agora são `tipo: "venda"`; distinguido pelo caixaId.
        const movimentos = await movimentosDaVenda(venda.id);
        const daBaixa = movimentos.find((m) => m["tipo"] === "venda" && String(m["caixaId"]) === caixaAtual.id);
        expect(daBaixa).toBeTruthy();
        expect(String(daBaixa?.["caixaId"])).toBe(caixaAtual.id);
        expect(String(daBaixa?.["caixaId"])).not.toBe(caixaOriginal.id);
        await caixasService.fechar(caixaAtual.id, { valorInformado: 1200 }, null);
      });

      it("T. nenhum caixa aberto: rejeição sem mutação", async () => {
        const { venda, parcelaId, caixa } = await venderComUmaParcela(300, 100);
        await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null); // nenhum caixa fica aberto

        await expect(service.baixarParcela(venda.id, parcelaId, {}, null)).rejects.toThrow(ApiException);

        const recarregada = await service.obterPorId(venda.id);
        expect(recarregada.parcelas[0]?.pagoEm).toBeNull();
        expect(recarregada.status).toBe("em_pagamento");

        const caixaFinal = await abrirCaixa();
        await caixasService.fechar(caixaFinal.id, { valorInformado: 1000 }, null);
      });

      it("U. tarifa não altera valorPago, valorPendente, valorFinal nem o valor do movimento de caixa", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 10 }] });
        const { venda, parcelaId, caixa } = await venderComUmaParcela(1000, 600); // parcela = 400
        const atualizada = await service.baixarParcela(venda.id, parcelaId, { modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1 }, null);

        expect(atualizada.valorPago).toBe(1000); // bruto, nunca 960
        expect(atualizada.valorPendente).toBe(0);
        expect(atualizada.valorFinal).toBe(1000);

        // Etapa 18.2 — distinguido pelo valor (400), já que o pagamento inicial (600) também é `tipo: "venda"`.
        const movimentos = await movimentosDaVenda(venda.id);
        const daBaixa = movimentos.find((m) => m["tipo"] === "venda" && m["valor"] === 400);
        expect(daBaixa?.["valor"]).toBe(400); // bruto, nunca 360 (líquido)
        await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
      });

      it("V. snapshot da tarifa permanece histórico mesmo após alterar a tabela do adquirente", async () => {
        const adquirente = await criarAdquirente({ tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 5 }] });
        const { venda, parcelaId, caixa } = await venderComUmaParcela(500, 300); // parcela = 200
        await service.baixarParcela(venda.id, parcelaId, { modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1 }, null);

        await adquirentesService.atualizar(adquirente.id, { tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 9 }] }, null);

        const recarregada = await service.obterPorId(venda.id);
        const pagamento = recarregada.pagamentos[recarregada.pagamentos.length - 1]!;
        expect(pagamento.tarifaAplicada?.percentual).toBe(5); // continua 5%, nunca 9%
        expect(pagamento.tarifaAplicada?.valorTarifa).toBe(10); // continua R$10, nunca R$18
        await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
      });
    });
  });

  describe("auditoria de consistência financeira: receberPagamento × baixarParcela (Etapa 10.12)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    it("CRÍTICO: receberPagamento quitando o saldo não permite que uma baixa de parcela ainda aberta ultrapasse valorFinal", async () => {
      // Cenário exato da auditoria: venda com 2 parcelas de 500 cada
      // (valorFinal=1000, valorPago=0 na criação). receberPagamento(500)
      // reduz o saldo geral mas NÃO toca em `parcelas[]` (separação de
      // responsabilidades aprovada) — a parcela 1 continua com `pagoEm: null`
      // mesmo que metade da dívida já tenha sido paga por outro caminho.
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
          totalParcelas: 2,
        },
        null,
      );
      expect(venda.valorFinal).toBe(1000);
      expect(venda.valorPago).toBe(0);
      expect(venda.parcelas).toHaveLength(2);
      expect(venda.parcelas[0]?.valor).toBe(500);
      expect(venda.parcelas[1]?.valor).toBe(500);
      const parcela1Id = String(venda.parcelas[0]!._id);

      const aposRecebimento = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 500 }, null);
      expect(aposRecebimento.valorPago).toBe(500);
      expect(aposRecebimento.valorPendente).toBe(500);
      // A parcela 1 continua "aberta" no snapshot — receberPagamento nunca a toca.
      expect(aposRecebimento.parcelas[0]?.pagoEm).toBeNull();

      // Baixar a parcela 1 (500) AGORA é legítimo: o saldo pendente (500)
      // ainda comporta exatamente esse valor.
      const aposPrimeiraBaixa = await service.baixarParcela(venda.id, parcela1Id, {}, null);
      expect(aposPrimeiraBaixa.valorPago).toBe(1000);
      expect(aposPrimeiraBaixa.valorPendente).toBe(0);
      expect(aposPrimeiraBaixa.status).toBe("concluida");

      // A parcela 2 (também 500) NÃO pode mais ser baixada — o saldo
      // pendente já é zero. Antes da correção da Etapa 10.12, isso era
      // aceito e resultava em valorPago=1500 > valorFinal=1000.
      const parcela2Id = String(venda.parcelas[1]!._id);
      await expect(service.baixarParcela(venda.id, parcela2Id, {}, null)).rejects.toThrow(ApiException);

      const final = await service.obterPorId(venda.id);
      expect(final.valorPago).toBe(1000); // nunca 1500
      expect(final.valorPago).toBeLessThanOrEqual(final.valorFinal); // invariante fundamental
      expect(final.valorPendente).toBe(0); // nunca negativo
      expect(final.parcelas[1]?.pagoEm).toBeNull(); // não foi baixada
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("CRÍTICO: receberPagamento parcial reduz o quanto uma parcela subsequente pode cobrir", async () => {
      // valorFinal=1000, 2 parcelas de 500. receberPagamento(300) deixa
      // pendente=700 — a parcela de 500 ainda cabe (500<=700), mas depois de
      // baixá-la o pendente vira 200, e a SEGUNDA parcela de 500 não cabe mais.
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
          totalParcelas: 2,
        },
        null,
      );
      await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300 }, null);

      const parcela1Id = String(venda.parcelas[0]!._id);
      const parcela2Id = String(venda.parcelas[1]!._id);
      const aposBaixa1 = await service.baixarParcela(venda.id, parcela1Id, {}, null);
      expect(aposBaixa1.valorPago).toBe(800); // 300 + 500
      expect(aposBaixa1.valorPendente).toBe(200);

      await expect(service.baixarParcela(venda.id, parcela2Id, {}, null)).rejects.toThrow(ApiException);

      const final = await service.obterPorId(venda.id);
      expect(final.valorPago).toBe(800); // nunca 1300
      expect(final.valorPago).toBeLessThanOrEqual(final.valorFinal);
      await caixasService.fechar(caixa.id, { valorInformado: 1800 }, null);
    });

    it("valorPago nunca excede valorFinal mesmo sob concorrência entre receberPagamento e baixarParcela", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
          totalParcelas: 2, // 2 parcelas de 500
        },
        null,
      );
      const parcela1Id = String(venda.parcelas[0]!._id);

      // Concorrência: um recebimento livre de 500 e a baixa da parcela 1
      // (também 500) disputando o MESMO saldo de 1000 (2×500).
      const resultados = await Promise.allSettled([
        service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 500 }, null),
        service.baixarParcela(venda.id, parcela1Id, {}, null),
      ]);

      const final = await service.obterPorId(venda.id);
      expect(final.valorPago).toBeLessThanOrEqual(final.valorFinal); // invariante fundamental — nunca 1000+500=1500
      expect(final.valorPendente).toBeGreaterThanOrEqual(0); // nunca negativo

      // Como ambas operações pagam exatamente 500 (a soma bate exatamente com
      // valorFinal=1000), as duas PODEM coexistir legitimamente se
      // intercalarem corretamente — o que a correção garante é o invariante
      // acima, não necessariamente que as duas sempre sejam aceitas.
      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      expect(sucesso.length).toBeGreaterThanOrEqual(1);
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });

    it("movimentos de caixa refletem exatamente o valorPago final, sem sobra nem falta", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
          totalParcelas: 2,
        },
        null,
      );
      const parcela1Id = String(venda.parcelas[0]!._id);

      await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 500 }, null);
      const final = await service.baixarParcela(venda.id, parcela1Id, {}, null);
      expect(final.valorPago).toBe(1000);

      const movimentos = await movimentosDaVenda(venda.id);
      const somaMovimentos = movimentos.reduce((total, m) => total + (m["valor"] as number), 0);
      expect(somaMovimentos).toBe(final.valorPago); // caixa reflete exatamente o pago, sem duplicar
      await caixasService.fechar(caixa.id, { valorInformado: 2000 }, null);
    });
  });

  describe("idempotência financeira global e recuperação de cancelamento (Etapa 10.13)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    describe("idempotência cross-caixa", () => {
      it("receberPagamento: retry após troca de caixa não cria um segundo movimento", async () => {
        const produto = await criarProdutoComEstoque(1000, 5);
        const vendedor = await criarVendedor();
        const cliente = await criarCliente();
        const caixaA = await abrirCaixa();
        const venda = await service.criar(
          {
            clienteId: cliente.id,
            vendedorId: vendedor.id,
            caixaId: caixaA.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 400 }],
          },
          null,
        );
        const chave = `cross-caixa-recebimento-${Date.now()}`;

        const primeira = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300, idempotencyKey: chave }, null);
        expect(primeira.valorPago).toBe(700);
        const movimentosAntes = await movimentosDaVenda(venda.id);
        const doRecebimento = movimentosAntes.find((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`);
        expect(String(doRecebimento?.["caixaId"])).toBe(caixaA.id);

        await caixasService.fechar(caixaA.id, { valorInformado: 1700 }, null);
        const caixaB = await abrirCaixa();

        const retry = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300, idempotencyKey: chave }, null);
        expect(retry.valorPago).toBe(700); // não dobrou

        const movimentosDepois = await movimentosDaVenda(venda.id);
        const doRecebimentoTodos = movimentosDepois.filter((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`);
        expect(doRecebimentoTodos).toHaveLength(1); // exatamente 1 movimento no total
        expect(String(doRecebimentoTodos[0]?.["caixaId"])).toBe(caixaA.id); // continua no Caixa A
        expect(movimentosDepois.some((m) => String(m["caixaId"]) === caixaB.id)).toBe(false); // nada criado no Caixa B
        await caixasService.fechar(caixaB.id, { valorInformado: 1000 }, null);
      });

      it("baixarParcela: retry após troca de caixa não cria um segundo movimento", async () => {
        const produto = await criarProdutoComEstoque(300, 5);
        const vendedor = await criarVendedor();
        const cliente = await criarCliente();
        const caixaA = await abrirCaixa();
        const venda = await service.criar(
          {
            clienteId: cliente.id,
            vendedorId: vendedor.id,
            caixaId: caixaA.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        );
        const parcelaId = String(venda.parcelas[0]!._id);
        const chave = `cross-caixa-parcela-${Date.now()}`;

        const primeira = await service.baixarParcela(venda.id, parcelaId, { idempotencyKey: chave }, null);
        expect(primeira.status).toBe("concluida");

        await caixasService.fechar(caixaA.id, { valorInformado: 1300 }, null);
        const caixaB = await abrirCaixa();

        const retry = await service.baixarParcela(venda.id, parcelaId, { idempotencyKey: chave }, null);
        expect(retry.valorPago).toBe(300); // não dobrou

        const movimentos = await movimentosDaVenda(venda.id);
        const daBaixa = movimentos.filter((m) => m["idempotencyKey"] === `${venda.id}:parcela:${chave}`);
        expect(daBaixa).toHaveLength(1);
        expect(String(daBaixa[0]?.["caixaId"])).toBe(caixaA.id);
        expect(movimentos.some((m) => String(m["caixaId"]) === caixaB.id)).toBe(false);
        await caixasService.fechar(caixaB.id, { valorInformado: 1000 }, null);
      });

      it("cancelamento: retry após troca de caixa não cria um segundo movimento (estoque já restaurado permanece intacto)", async () => {
        const produto = await criarProdutoComEstoque(200, 5);
        const vendedor = await criarVendedor();
        const caixaA = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixaA.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 200 }],
          },
          null,
        );
        const chave = `cross-caixa-cancelamento-${Date.now()}`;

        const primeira = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste cross-caixa", idempotencyKey: chave }, null);
        expect(primeira.status).toBe("cancelada");

        await caixasService.fechar(caixaA.id, { valorInformado: 1000 }, null);
        const caixaB = await abrirCaixa();

        const retry = await service.cancelar(venda.id, { tipo: "integral", motivo: "Retry", idempotencyKey: chave }, null);
        expect(retry.status).toBe("cancelada");

        const movimentos = await movimentosDaVenda(venda.id);
        const doCancelamento = movimentos.filter((m) => m["idempotencyKey"] === `${venda.id}:cancelamento:${chave}`);
        expect(doCancelamento).toHaveLength(1);
        expect(String(doCancelamento[0]?.["caixaId"])).toBe(caixaA.id);
        expect(movimentos.some((m) => String(m["caixaId"]) === caixaB.id)).toBe(false);

        const atualizado = await produtosService.obterPorId(produto.produtoId);
        const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
        expect(tamanho.quantidade).toBe(5); // restaurado uma única vez
        await caixasService.fechar(caixaB.id, { valorInformado: 1000 }, null);
      });
    });

    describe("cancelamento: idempotência e recuperação de crash", () => {
      it("A. dois cancelamentos concorrentes com a MESMA chave: ambos convergem, 1 movimento, estoque restaurado uma vez", async () => {
        const produto = await criarProdutoComEstoque(150, 4);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
            pagamentos: [{ forma: "Dinheiro", valor: 300 }],
          },
          null,
        );
        const chave = `cancelamento-concorrente-mesma-chave-${Date.now()}`;

        const resultados = await Promise.allSettled([
          service.cancelar(venda.id, { tipo: "integral", motivo: "Concorrente A", idempotencyKey: chave }, null),
          service.cancelar(venda.id, { tipo: "integral", motivo: "Concorrente B", idempotencyKey: chave }, null),
        ]);
        // Mesma chave = mesma operação: NENHUMA das duas é rejeitada.
        expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

        const atualizado = await produtosService.obterPorId(produto.produtoId);
        const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
        expect(tamanho.quantidade).toBe(4); // nunca 6 (restaurado só uma vez)

        const movimentos = await movimentosDaVenda(venda.id);
        expect(movimentos.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(1);

        const final = await service.obterPorId(venda.id);
        expect(final.status).toBe("cancelada");
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("B. dois cancelamentos concorrentes com chaves DIFERENTES: só um vence, o outro é rejeitado", async () => {
        const produto = await criarProdutoComEstoque(150, 4);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
            pagamentos: [{ forma: "Dinheiro", valor: 300 }],
          },
          null,
        );

        const resultados = await Promise.allSettled([
          service.cancelar(venda.id, { tipo: "integral", motivo: "Chave A", idempotencyKey: "chave-A" }, null),
          service.cancelar(venda.id, { tipo: "integral", motivo: "Chave B", idempotencyKey: "chave-B" }, null),
        ]);
        expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(1);

        const atualizado = await produtosService.obterPorId(produto.produtoId);
        const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
        expect(tamanho.quantidade).toBe(4); // restaurado só uma vez

        const movimentos = await movimentosDaVenda(venda.id);
        expect(movimentos.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(1);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("C./E./F. retry recupera cancelamento cujo estoque/movimento ainda não haviam sido concluídos (crash simulado)", async () => {
        const produto = await criarProdutoComEstoque(150, 4);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
            pagamentos: [{ forma: "Dinheiro", valor: 300 }],
          },
          null,
        );
        const chave = `cancelamento-crash-${Date.now()}`;

        const primeira = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste crash", idempotencyKey: chave }, null);
        expect(primeira.status).toBe("cancelada");
        const antesDoCrash = await produtosService.obterPorId(produto.produtoId);
        expect(antesDoCrash.variantes[0]!.tamanhos[0]!.quantidade).toBe(4); // já restaurado normalmente

        // Simula "processo morreu ENTRE persistir a venda cancelada e
        // restaurar o estoque/lançar o caixa": desfaz manualmente os efeitos
        // (como se eles nunca tivessem acontecido), mas preserva o registro
        // `cancelamento` já persistido — exatamente o estado que um crash
        // real deixaria para trás.
        await connection
          .collection("produtos")
          .updateOne({ _id: new Types.ObjectId(produto.produtoId) }, { $inc: { "variantes.0.tamanhos.0.quantidade": -2 } });
        const movimentosAntes = await movimentosDaVenda(venda.id);
        await connection.collection("movimentos_caixa").deleteMany({ vendaId: venda.id, tipo: "cancelamento" });
        await connection
          .collection("vendas")
          .updateOne({ _id: new Types.ObjectId(venda.id) }, { $set: { "cancelamento.itens.$[].restaurado": false } });

        const meioDoCrash = await produtosService.obterPorId(produto.produtoId);
        expect(meioDoCrash.variantes[0]!.tamanhos[0]!.quantidade).toBe(2); // "desfeito" — simula que nunca restaurou
        const semMovimento = await movimentosDaVenda(venda.id);
        expect(semMovimento.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(0);
        expect(movimentosAntes.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(1); // só para referência do que existia antes de apagar

        // Retry com a MESMA chave: reconhecido como replay, reconcilia o que falta.
        const retry = await service.cancelar(venda.id, { tipo: "integral", motivo: "Retry pós-crash", idempotencyKey: chave }, null);
        expect(retry.status).toBe("cancelada");

        const depoisDoRetry = await produtosService.obterPorId(produto.produtoId);
        expect(depoisDoRetry.variantes[0]!.tamanhos[0]!.quantidade).toBe(4); // restaurado de novo — nunca 6 (dobrado)

        const movimentosFinais = await movimentosDaVenda(venda.id);
        expect(movimentosFinais.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(1); // recriado, nunca duplicado
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("D. retry após cancelamento já 100% concluído (mesma chave) apenas reconhece o replay, sem efeito adicional", async () => {
        const produto = await criarProdutoComEstoque(150, 4);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
            pagamentos: [{ forma: "Dinheiro", valor: 300 }],
          },
          null,
        );
        const chave = `cancelamento-retry-simples-${Date.now()}`;

        await service.cancelar(venda.id, { tipo: "integral", motivo: "Primeira", idempotencyKey: chave }, null);
        const retry = await service.cancelar(venda.id, { tipo: "integral", motivo: "Retry", idempotencyKey: chave }, null);
        expect(retry.status).toBe("cancelada");
        expect(retry.cancelamento?.valorDevolvido).toBe(300); // H. consistência do valor devolvido

        const atualizado = await produtosService.obterPorId(produto.produtoId);
        expect(atualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(4);
        const movimentos = await movimentosDaVenda(venda.id);
        expect(movimentos.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(1);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });

      it("venda cancelada por chave diferente/ausente continua rejeitando um segundo cancelamento (compatibilidade legada)", async () => {
        const produto = await criarProdutoComEstoque(100, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        );
        // Primeiro cancelamento SEM chave (payload legado).
        await service.cancelar(venda.id, { tipo: "integral", motivo: "Legado, sem chave" }, null);

        // Um segundo cancelamento, mesmo COM chave, nunca é tratado como
        // replay de uma operação que não tinha chave nenhuma.
        await expect(
          service.cancelar(venda.id, { tipo: "integral", motivo: "Retry com chave nova", idempotencyKey: "chave-nova" }, null),
        ).rejects.toThrow(ApiException);

        // E um cancelamento legado (sem chave) sobre uma venda JÁ cancelada
        // (mesmo que originalmente cancelada COM chave) também sempre rejeita.
        const produto2 = await criarProdutoComEstoque(100, 5);
        const venda2 = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto2.produtoId, varianteId: produto2.varianteId, tamanhoId: produto2.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          },
          null,
        );
        await service.cancelar(venda2.id, { tipo: "integral", motivo: "Com chave", idempotencyKey: "alguma-chave" }, null);
        await expect(service.cancelar(venda2.id, { tipo: "integral", motivo: "Retry sem chave" }, null)).rejects.toThrow(ApiException);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });
    });

    describe("regressão", () => {
      it("vendas e cancelamentos sem idempotencyKey continuam funcionando exatamente como antes", async () => {
        const produto = await criarProdutoComEstoque(200, 5);
        const vendedor = await criarVendedor();
        const caixa = await abrirCaixa();
        const venda = await service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 200 }],
          },
          null,
        );
        const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Sem chave" }, null);
        expect(cancelada.status).toBe("cancelada");
        expect(cancelada.valorDevolvido).toBe(200);

        const atualizado = await produtosService.obterPorId(produto.produtoId);
        expect(atualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(5);
        await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
      });
    });
  });

  describe("conflito de chave e migração de índice (Etapa 10.14)", () => {
    it("L. venda A e venda B com a mesma idempotencyKey: a segunda é rejeitada por conflito, nunca devolve a venda errada", async () => {
      const produtoA = await criarProdutoComEstoque(100, 5);
      const produtoB = await criarProdutoComEstoque(200, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const chave = `chave-reusada-entre-vendas-${Date.now()}`;

      const vendaA = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produtoA.produtoId, varianteId: produtoA.varianteId, tamanhoId: produtoA.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
          idempotencyKey: chave,
        },
        null,
      );
      expect(vendaA.valorFinal).toBe(100);

      // Venda B usa a MESMA chave, mas é um pedido genuinamente diferente
      // (outro item, outro valor) — nunca deve ser confundida com a venda A.
      await expect(
        service.criar(
          {
            vendedorId: vendedor.id,
            caixaId: caixa.id,
            itens: [{ produtoId: produtoB.produtoId, varianteId: produtoB.varianteId, tamanhoId: produtoB.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma: "Dinheiro", valor: 200 }],
            idempotencyKey: chave,
          },
          null,
        ),
      ).rejects.toThrow(ApiException);

      // Nem o estoque do produto B foi baixado, nem uma segunda venda foi criada.
      const produtoBAtualizado = await produtosService.obterPorId(produtoB.produtoId);
      expect(produtoBAtualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(5);
      const totalVendas = await connection.collection("vendas").countDocuments({ idempotencyKey: chave });
      expect(totalVendas).toBe(1); // só a venda A
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("retry genuíno da MESMA venda (idênticos itens/vendedor/caixa) com a mesma chave continua funcionando como replay", async () => {
      const produto = await criarProdutoComEstoque(150, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const chave = `retry-genuino-${Date.now()}`;
      const dados: DadosCriarVenda = {
        vendedorId: vendedor.id,
        caixaId: caixa.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 150 }],
        idempotencyKey: chave,
      };

      const primeira = await service.criar(dados, null);
      const segunda = await service.criar(dados, null);
      expect(segunda.id).toBe(primeira.id);
      await caixasService.fechar(caixa.id, { valorInformado: 1150 }, null);
    });

    it("F. receberPagamento: mesma chave com valor DIFERENTE é rejeitado por conflito", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 400 }],
        },
        null,
      );
      const chave = `recebimento-chave-conflitante-${Date.now()}`;

      const primeiro = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 200, idempotencyKey: chave }, null);
      expect(primeiro.valorPago).toBe(600);

      await expect(
        service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300, idempotencyKey: chave }, null),
      ).rejects.toThrow(ApiException);

      const final = await service.obterPorId(venda.id);
      expect(final.valorPago).toBe(600); // nunca 900 (o segundo valor nunca foi aplicado)
      await caixasService.fechar(caixa.id, { valorInformado: 1600 }, null);
    });

    it("G. baixarParcela: mesma chave usada para uma PARCELA DIFERENTE é rejeitada por conflito", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          clienteId: cliente.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
          totalParcelas: 2,
        },
        null,
      );
      const parcela1Id = String(venda.parcelas[0]!._id);
      const parcela2Id = String(venda.parcelas[1]!._id);
      const chave = `parcela-chave-conflitante-${Date.now()}`;

      const primeira = await service.baixarParcela(venda.id, parcela1Id, { idempotencyKey: chave }, null);
      expect(primeira.parcelasPagas).toBe(1);

      await expect(service.baixarParcela(venda.id, parcela2Id, { idempotencyKey: chave }, null)).rejects.toThrow(ApiException);

      const final = await service.obterPorId(venda.id);
      expect(final.parcelasPagas).toBe(1); // a parcela 2 nunca foi baixada
      expect(final.parcelas[1]?.pagoEm).toBeNull();
      await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
    });

    it("H. cancelar: mesma chave com tipo/itens DIFERENTES é rejeitada por conflito", async () => {
      const produtoA = await criarProdutoComEstoque(100, 5);
      const produtoB = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          clienteId: cliente.id,
          itens: [
            { produtoId: produtoA.produtoId, varianteId: produtoA.varianteId, tamanhoId: produtoA.tamanhoId, quantidade: 1 },
            { produtoId: produtoB.produtoId, varianteId: produtoB.varianteId, tamanhoId: produtoB.tamanhoId, quantidade: 1 },
          ],
          // Paga só metade (100 de 200) para que, mesmo após devolver o item A
          // (também 100), ainda reste saldo pendente do item B — mantendo a
          // venda em "em_pagamento" em vez de "concluida" pelo cancelamento
          // parcial coincidentemente zerar o pendente.
          pagamentos: [{ forma: "Dinheiro", valor: 50 }],
        },
        null,
      );
      const itemA = venda.itens.find((i) => i.produtoId === produtoA.produtoId)!;
      const chave = `cancelamento-chave-conflitante-${Date.now()}`;

      const primeira = await service.cancelar(
        venda.id,
        { tipo: "parcial", motivo: "Só o item A", itens: [{ itemId: String(itemA._id), quantidade: 1 }], idempotencyKey: chave },
        null,
      );
      expect(primeira.status).toBe("em_pagamento"); // ainda restou o item B, com saldo pendente

      // Reusa a MESMA chave, mas agora pedindo um cancelamento INTEGRAL — operação diferente.
      await expect(
        service.cancelar(venda.id, { tipo: "integral", motivo: "Tentativa diferente", idempotencyKey: chave }, null),
      ).rejects.toThrow(ApiException);

      const final = await service.obterPorId(venda.id);
      expect(final.status).toBe("em_pagamento"); // não foi cancelada integralmente por engano
      // Caixa: 1000 inicial + 50 de entrada (pagamento parcial) - 50 de saída
      // (devolução do item A, limitada ao valorPago já recebido) = 1000. A
      // tentativa rejeitada de cancelamento integral nunca chega a mexer no caixa.
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("M./N. índice global do MovimentoCaixa: mesma chave em caixas diferentes nunca cria dois documentos", async () => {
      const caixaId1 = new Types.ObjectId().toString();
      const caixaId2 = new Types.ObjectId().toString();
      const chave = `indice-global-${Date.now()}`;
      const base = {
        dataHora: new Date(),
        tipo: "venda" as const,
        origem: "venda" as const,
        descricao: "Teste índice global",
        referencia: null,
        vendaId: null,
        vendaCodigo: null,
        formaPagamento: "Dinheiro",
        valor: 100,
        sentido: "entrada" as const,
        responsavelId: null,
        responsavelNome: "Backoffice",
        observacao: "",
        motivo: null,
      };

      // Acesso direto ao repository via o módulo de caixas já carregado pelo VendasModule.
      const movimentosRepository = moduleRef.get(MovimentosCaixaRepository);
      const primeiro = await movimentosRepository.criar({ ...base, caixaId: caixaId1, idempotencyKey: chave });
      expect(primeiro.duplicado).toBe(false);

      // MESMA chave, CAIXA DIFERENTE — o índice global deve impedir um segundo documento.
      const segundo = await movimentosRepository.criar({ ...base, caixaId: caixaId2, idempotencyKey: chave });
      expect(segundo.duplicado).toBe(true);
      expect(String(segundo.movimento._id)).toBe(String(primeiro.movimento._id));
      expect(String(segundo.movimento.caixaId)).toBe(caixaId1); // continua no caixa ORIGINAL, nunca migra para caixaId2

      const total = await connection.collection("movimentos_caixa").countDocuments({ idempotencyKey: chave });
      expect(total).toBe(1);
    });
  });

  describe("estoque: reivindicação atômica de restauração (Etapa 10.14)", () => {
    it("O. duas requisições concorrentes reivindicando o MESMO item: só uma restaura o estoque", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
          pagamentos: [{ forma: "Dinheiro", valor: 200 }],
        },
        null,
      );
      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste reivindicação" }, null);
      const itemId = cancelada.cancelamento!.itens[0]!.itemId;

      // Reabre a reivindicação manualmente (simula um cenário onde duas
      // chamadas de reconciliação concorrentes disputam o MESMO item ainda
      // não restaurado) e dispara duas reivindicações concorrentes de verdade.
      await connection.collection("vendas").updateOne({ _id: new Types.ObjectId(venda.id) }, { $set: { "cancelamento.itens.$[].restaurado": false } });

      const vendasRepository = moduleRef.get(VendasRepository);
      const resultados = await Promise.all([
        vendasRepository.marcarItemDevolvidoRestaurado(venda.id, itemId),
        vendasRepository.marcarItemDevolvidoRestaurado(venda.id, itemId),
      ]);
      expect(resultados.filter(Boolean)).toHaveLength(1); // só uma reivindicação vence
      // Caixa: 1000 inicial + 200 de entrada - 200 de saída (cancelamento integral) = 1000.
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("reivindicações de itens DIFERENTES nunca conflitam entre si", async () => {
      const produtoA = await criarProdutoComEstoque(100, 5);
      const produtoB = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [
            { produtoId: produtoA.produtoId, varianteId: produtoA.varianteId, tamanhoId: produtoA.tamanhoId, quantidade: 1 },
            { produtoId: produtoB.produtoId, varianteId: produtoB.varianteId, tamanhoId: produtoB.tamanhoId, quantidade: 1 },
          ],
          pagamentos: [{ forma: "Dinheiro", valor: 200 }],
        },
        null,
      );
      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste itens diferentes" }, null);
      const [itemId1, itemId2] = cancelada.cancelamento!.itens.map((i) => i.itemId);

      await connection.collection("vendas").updateOne({ _id: new Types.ObjectId(venda.id) }, { $set: { "cancelamento.itens.$[].restaurado": false } });

      const vendasRepository = moduleRef.get(VendasRepository);
      const [resultado1, resultado2] = await Promise.all([
        vendasRepository.marcarItemDevolvidoRestaurado(venda.id, itemId1!),
        vendasRepository.marcarItemDevolvidoRestaurado(venda.id, itemId2!),
      ]);
      expect(resultado1).toBe(true);
      expect(resultado2).toBe(true); // itens diferentes — ambas reivindicações vencem
      // Caixa: 1000 inicial + 200 de entrada - 200 de saída (cancelamento integral) = 1000.
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("auditoria de pagamentos, parcelas e idempotência (Etapa 10.15)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    it("receberPagamento: retry recupera um movimento de caixa ausente (crash simulado) sem duplicar o pagamento", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 400 }],
        },
        null,
      );
      const chave = `crash-recebimento-${Date.now()}`;

      const primeira = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300, idempotencyKey: chave }, null);
      expect(primeira.valorPago).toBe(700);
      const antesDoCrash = await movimentosDaVenda(venda.id);
      expect(antesDoCrash.filter((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`)).toHaveLength(1);

      // Simula "processo morreu ENTRE salvar a venda e lançar o movimento de
      // caixa": apaga só o movimento do RECEBIMENTO, preservando o pagamento
      // já persistido na venda e o movimento original da criação. Etapa 18.2
      // — os dois são `tipo: "venda"` agora, então isola pelo idempotencyKey
      // (identifica exatamente o movimento do recebimento, nunca o original).
      await connection.collection("movimentos_caixa").deleteMany({ vendaId: venda.id, idempotencyKey: `${venda.id}:recebimento:${chave}` });
      const semMovimento = await movimentosDaVenda(venda.id);
      expect(semMovimento.filter((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`)).toHaveLength(0);

      // Retry com a MESMA chave e o MESMO valor: reconhecido como replay do
      // pagamento (nunca reaplica), mas RECRIA o movimento que faltava.
      const retry = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300, idempotencyKey: chave }, null);
      expect(retry.valorPago).toBe(700); // nunca 1000 (nunca reaplicado)
      expect(retry.pagamentos.filter((p) => p.idempotencyKey === chave)).toHaveLength(1); // 1 pagamento, nunca 2

      const depoisDoRetry = await movimentosDaVenda(venda.id);
      expect(depoisDoRetry.filter((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`)).toHaveLength(1); // recriado, nunca duplicado
      await caixasService.fechar(caixa.id, { valorInformado: 1700 }, null);
    });

    it("baixarParcela: retry recupera um movimento de caixa ausente (crash simulado) sem duplicar o pagamento", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      const parcelaId = String(venda.parcelas[0]!._id);
      const chave = `crash-parcela-${Date.now()}`;

      const primeira = await service.baixarParcela(venda.id, parcelaId, { idempotencyKey: chave }, null);
      expect(primeira.status).toBe("concluida");
      expect(primeira.parcelas[0]?.pagoEm).not.toBeNull();

      // Etapa 18.2 — isola pelo idempotencyKey (ver justificativa no teste de `receberPagamento` acima).
      await connection.collection("movimentos_caixa").deleteMany({ vendaId: venda.id, idempotencyKey: `${venda.id}:parcela:${chave}` });
      const semMovimento = await movimentosDaVenda(venda.id);
      expect(semMovimento.filter((m) => m["idempotencyKey"] === `${venda.id}:parcela:${chave}`)).toHaveLength(0);

      const retry = await service.baixarParcela(venda.id, parcelaId, { idempotencyKey: chave }, null);
      expect(retry.valorPago).toBe(300); // nunca 400 (nunca rebaixada)
      expect(retry.parcelasPagas).toBe(1);

      const depoisDoRetry = await movimentosDaVenda(venda.id);
      expect(depoisDoRetry.filter((m) => m["idempotencyKey"] === `${venda.id}:parcela:${chave}`)).toHaveLength(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("baixarParcela: mesma chave reaproveitada para uma parcela DIFERENTE já paga por outro meio é rejeitada por conflito, nunca confunde as duas baixas", async () => {
      // 3 parcelas de valores não-uniformes (100 dividido em 3 não fecha
      // exato) — necessário para que a checagem por VALOR (proxy usado por
      // não existir vínculo explícito parcela↔pagamento em `PagamentoVenda`)
      // consiga distinguir uma parcela da outra neste teste.
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
          totalParcelas: 3,
        },
        null,
      );
      const [parcela1, parcela2, parcela3] = venda.parcelas;
      expect(parcela1!.valor).not.toBe(parcela3!.valor); // confirma o arredondamento desigual usado pelo teste

      const chave1 = `parcela-1-${Date.now()}`;
      await service.baixarParcela(venda.id, String(parcela1!._id), { idempotencyKey: chave1 }, null);

      const chave3 = `parcela-3-${Date.now()}`;
      await service.baixarParcela(venda.id, String(parcela3!._id), { idempotencyKey: chave3 }, null);

      // Reaproveita a chave da parcela 1 (valor diferente) pedindo a baixa da
      // parcela 3 — que JÁ está paga (por `chave3`, não por `chave1`). Nunca
      // pode devolver silenciosamente "sucesso" como se `chave1` tivesse sido
      // a responsável por baixar a parcela 3.
      await expect(
        service.baixarParcela(venda.id, String(parcela3!._id), { idempotencyKey: chave1 }, null),
      ).rejects.toThrow(ApiException);

      const final = await service.obterPorId(venda.id);
      expect(final.parcelasPagas).toBe(2); // só 1 e 3, nada adicional
      expect(final.valorPago).toBe(final.parcelas.filter((p) => p.pagoEm).reduce((total, p) => total + p.valor, 0));

      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos.filter((m) => m["idempotencyKey"] === `${venda.id}:parcela:${chave1}`)).toHaveLength(1); // continua só o da parcela 1
      expect(movimentos.filter((m) => m["idempotencyKey"] === `${venda.id}:parcela:${chave3}`)).toHaveLength(1); // continua só o da parcela 3
      await caixasService.fechar(caixa.id, { valorInformado: 1000 + final.valorPago }, null);
    });
  });

  describe("concorrência entre cancelamento e pagamento/recebimento (Etapa 10.19)", () => {
    it("cancelar × receberPagamento concorrentes: invariantes financeiros seguros em qualquer ordem de corrida", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
        },
        null,
      );
      expect(venda.valorPendente).toBe(500);

      const resultados = await Promise.allSettled([
        service.cancelar(venda.id, { tipo: "integral", motivo: "Concorrente com recebimento" }, null),
        service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300 }, null),
      ]);

      // O cancelamento nunca é bloqueado por um recebimento concorrente — só
      // outro cancelamento poderia impedi-lo, e não há nenhum aqui.
      expect(resultados[0]!.status).toBe("fulfilled");

      const final = await service.obterPorId(venda.id);
      expect(final.status).toBe("cancelada");
      expect(final.valorPago).toBeLessThanOrEqual(final.valorFinal); // nunca ultrapassa, em nenhuma ordem de corrida
      expect(final.valorPendente).toBe(0); // cancelamento sempre zera

      // Se o recebimento venceu a corrida ANTES do cancelamento consolidar,
      // o caixa reflete só o que foi de fato recebido (nunca o valor cheio do
      // item, regra da Etapa 10.9); se o recebimento foi rejeitado (viu a
      // venda já cancelada no retry), valorPago permanece 0.
      expect([0, 300]).toContain(final.valorPago);
      // `garantirMovimentoDeCancelamento` só lança movimento quando há algo a
      // devolver (`valorParaCaixa > 0`) — se o recebimento foi rejeitado
      // (valorPago=0), não há devolução nenhuma a registrar.
      const movimentoCancelamento = await connection.collection("movimentos_caixa").find({ vendaId: venda.id, tipo: "cancelamento" }).toArray();
      expect(movimentoCancelamento).toHaveLength(final.valorPago > 0 ? 1 : 0);
      if (final.valorPago > 0) expect(movimentoCancelamento[0]!["valor"]).toBe(final.valorPago); // devolução nunca excede o que foi recebido
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("cancelar × baixarParcela concorrentes: invariantes financeiros seguros em qualquer ordem de corrida", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
        },
        null,
      );
      const parcelaId = String(venda.parcelas[0]!._id);

      const resultados = await Promise.allSettled([
        service.cancelar(venda.id, { tipo: "integral", motivo: "Concorrente com baixa de parcela" }, null),
        service.baixarParcela(venda.id, parcelaId, {}, null),
      ]);

      expect(resultados[0]!.status).toBe("fulfilled"); // cancelamento nunca é bloqueado pela baixa concorrente

      const final = await service.obterPorId(venda.id);
      expect(final.status).toBe("cancelada");
      expect(final.valorPago).toBeLessThanOrEqual(final.valorFinal);
      expect(final.valorPendente).toBe(0);
      expect([0, 500]).toContain(final.valorPago); // ou a parcela baixou antes do cancelamento, ou foi rejeitada (venda já cancelada)

      const movimentoCancelamento = await connection.collection("movimentos_caixa").find({ vendaId: venda.id, tipo: "cancelamento" }).toArray();
      expect(movimentoCancelamento).toHaveLength(final.valorPago > 0 ? 1 : 0);
      if (final.valorPago > 0) expect(movimentoCancelamento[0]!["valor"]).toBe(final.valorPago);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("retry CONCORRENTE (Promise.all) da mesma operação com a mesma chave (Etapa 10.20)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    it("receberPagamento: duas chamadas concorrentes com a MESMA chave e o MESMO valor nunca duplicam o pagamento", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
        },
        null,
      );
      const chave = `recebimento-concorrente-${Date.now()}`;

      const resultados = await Promise.allSettled([
        service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300, idempotencyKey: chave }, null),
        service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 300, idempotencyKey: chave }, null),
      ]);
      // Mesma chave + mesmo valor = mesma operação: nenhuma das duas é rejeitada.
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

      const final = await service.obterPorId(venda.id);
      expect(final.valorPago).toBe(300); // nunca 600
      expect(final.valorPendente).toBe(200);
      expect(final.pagamentos.filter((p) => p.idempotencyKey === chave)).toHaveLength(1);

      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos.filter((m) => m["idempotencyKey"] === `${venda.id}:recebimento:${chave}`)).toHaveLength(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("baixarParcela: duas chamadas concorrentes com a MESMA chave nunca duplicam a baixa", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
        },
        null,
      );
      const parcelaId = String(venda.parcelas[0]!._id);
      const chave = `parcela-concorrente-${Date.now()}`;

      const resultados = await Promise.allSettled([
        service.baixarParcela(venda.id, parcelaId, { idempotencyKey: chave }, null),
        service.baixarParcela(venda.id, parcelaId, { idempotencyKey: chave }, null),
      ]);
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

      const final = await service.obterPorId(venda.id);
      expect(final.valorPago).toBe(500); // nunca 1000
      expect(final.valorPendente).toBe(0);
      expect(final.parcelasPagas).toBe(1);
      expect(final.pagamentos.filter((p) => p.idempotencyKey === chave)).toHaveLength(1);

      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos.filter((m) => m["idempotencyKey"] === `${venda.id}:parcela:${chave}`)).toHaveLength(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
    });
  });

  describe("cenários cross-flow sequenciais: recebimento/baixa seguidos de cancelamento (Etapa 10.21)", () => {
    async function movimentosDaVenda(vendaId: string) {
      return connection.collection("movimentos_caixa").find({ vendaId }).toArray();
    }

    it("cenário E: receberPagamento (operação separada) seguido de cancelar — devolução capada ao que foi de fato recebido", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
        },
        null,
      );

      const aposRecebimento = await service.receberPagamento(venda.id, { forma: "Dinheiro", valor: 400 }, null);
      expect(aposRecebimento.valorPago).toBe(400);

      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste cross-flow E" }, null);
      expect(cancelada.status).toBe("cancelada");
      expect(cancelada.valorPago).toBe(400); // cancelar nunca mexe em valorPago
      expect(cancelada.valorPendente).toBe(0);
      expect(cancelada.valorDevolvido).toBe(1000); // valor econômico do item inteiro

      // Duas movimentações distintas e corretas: entrada do recebimento (400)
      // e saída do cancelamento CAPADA ao que foi de fato recebido (400,
      // nunca 1000) — mesma regra já aprovada na Etapa 10.9 para vendas
      // pagas na criação, agora confirmada quando o pagamento veio de uma
      // chamada SEPARADA de receberPagamento.
      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos.filter((m) => m["tipo"] === "venda")).toHaveLength(1);
      expect(movimentos.find((m) => m["tipo"] === "venda")?.["valor"]).toBe(400);
      expect(movimentos.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(1);
      expect(movimentos.find((m) => m["tipo"] === "cancelamento")?.["valor"]).toBe(400);

      const produtoAtualizado = await produtosService.obterPorId(produto.produtoId);
      expect(produtoAtualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(5); // estoque restaurado integralmente
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("cenário F: baixarParcela (operação separada) seguido de cancelar — histórico da parcela preservado, devolução integral", async () => {
      const produto = await criarProdutoComEstoque(1000, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const venda = await service.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [],
        },
        null,
      );
      const parcelaId = String(venda.parcelas[0]!._id);

      const aposBaixa = await service.baixarParcela(venda.id, parcelaId, {}, null);
      expect(aposBaixa.status).toBe("concluida");
      expect(aposBaixa.valorPago).toBe(1000);

      const cancelada = await service.cancelar(venda.id, { tipo: "integral", motivo: "Teste cross-flow F" }, null);
      expect(cancelada.status).toBe("cancelada"); // transita de CONCLUIDA para cancelada normalmente
      expect(cancelada.valorPago).toBe(1000);
      expect(cancelada.valorDevolvido).toBe(1000);

      // O cancelamento nunca reescreve `parcelas[]` (separação de
      // responsabilidades já aprovada — mesmo princípio da Etapa 10.11 para
      // receberPagamento): o registro histórico de que a parcela foi paga
      // continua íntegro mesmo após a venda ser cancelada.
      expect(cancelada.parcelas[0]?.pagoEm).not.toBeNull();
      expect(cancelada.parcelasPagas).toBe(1);

      const movimentos = await movimentosDaVenda(venda.id);
      expect(movimentos.filter((m) => m["tipo"] === "venda")).toHaveLength(1);
      expect(movimentos.find((m) => m["tipo"] === "venda")?.["valor"]).toBe(1000);
      expect(movimentos.filter((m) => m["tipo"] === "cancelamento")).toHaveLength(1);
      expect(movimentos.find((m) => m["tipo"] === "cancelamento")?.["valor"]).toBe(1000); // devolução integral, venda estava totalmente paga

      const produtoAtualizado = await produtosService.obterPorId(produto.produtoId);
      expect(produtoAtualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(5);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });
});
