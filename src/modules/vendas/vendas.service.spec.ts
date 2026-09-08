import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { AdquirentesService } from "../adquirentes/adquirentes.service.js";
import type { CriarAdquirenteDto } from "../adquirentes/dto/criar-adquirente.dto.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ClientesService } from "../clientes/clientes.service.js";
import type { CriarClienteDto } from "../clientes/dto/criar-cliente.dto.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { CriarVendedorDto } from "../vendedores/dto/criar-vendedor.dto.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import type { DadosCriarVenda } from "./vendas.types.js";
import type { ListarVendasQueryDto } from "./dto/listar-vendas-query.dto.js";
import { VendasModule } from "./vendas.module.js";
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
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
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
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
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
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
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
      const caixa = await abrirCaixa();

      const dadosForjados = {
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

    it("snapshot: descontoItem persiste no documento e é recuperável via obterPorId", async () => {
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
      const caixa = await abrirCaixa();

      const venda = await service.criar(
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
      const caixa = await abrirCaixa();

      await service.criar(
        {
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
      const caixa = await abrirCaixa();

      await service.criar(
        {
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
      const caixa = await abrirCaixa();

      await service.criar(
        {
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
      expect(venda.status).toBe("em_pagamento");
      const parcelaId = String(venda.parcelas[0]!._id);

      const atualizada = await service.baixarParcela(venda.id, parcelaId, { formaPagamento: "PIX" }, "admin-teste");
      expect(atualizada.status).toBe("concluida");
      expect(atualizada.valorPendente).toBe(0);
      expect(atualizada.parcelasPagas).toBe(1);

      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.totalVendas).toBe(100);
      expect(detalheCaixa.resumo.recebimentos).toBe(200);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("rejeita baixar uma parcela já paga", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
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
      const parcelaId = String(venda.parcelas[0]!._id);
      await service.baixarParcela(venda.id, parcelaId, {}, null);
      await expect(service.baixarParcela(venda.id, parcelaId, {}, null)).rejects.toThrow(ApiException);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });

    it("lança NOT_FOUND para parcela inexistente", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
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
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
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
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        {
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
});
