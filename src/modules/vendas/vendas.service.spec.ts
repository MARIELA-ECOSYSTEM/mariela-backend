import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
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
