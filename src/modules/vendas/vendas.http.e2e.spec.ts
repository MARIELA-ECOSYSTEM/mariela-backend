import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { AddressInfo } from "node:net";
import type { Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "../auth/auth.service.js";
import { AdquirentesService } from "../adquirentes/adquirentes.service.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ClientesService } from "../clientes/clientes.service.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { VendasService } from "./vendas.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global) — mesmo padrão dos demais módulos.
 *
 * Não existe `POST /api/v1/vendas` neste contrato (ver `vendas.controller.ts`):
 * a venda usada aqui é criada pelo mecanismo INTERNO (`VendasService.criar`,
 * chamado diretamente, fora do HTTP) — exatamente como o futuro PDV fará.
 */
describe("HTTP — Vendas (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;
  let vendaId: string;
  let vendaCodigo: string;
  let parcelaId: string;
  let caixaId: string;
  let contadorTelefone = 0;
  let produtosService: ProdutosService;
  let vendedoresService: VendedoresService;
  let clientesService: ClientesService;
  let caixasService: CaixasService;
  let vendasService: VendasService;
  let adquirentesService: AdquirentesService;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1198${String(contadorTelefone).padStart(6, "0")}`;
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  }

  /**
   * Cria, fora do HTTP (mesmo padrão do seed em `beforeAll`), uma venda
   * EM_PAGAMENTO para os testes de recebimento posterior. Reutiliza o ÚNICO
   * caixa aberto do arquivo inteiro (`CaixasRepository` só permite um caixa
   * aberto por vez, sistema afora — nenhum teste deste arquivo fecha o caixa
   * seedado em `beforeAll`) em vez de abrir um novo, que causaria 409.
   */
  async function criarVendaFiadaViaHttpSetup(valorItem: number, valorPagoNaCriacao: number) {
    const produto = await produtosService.criar({ nome: `Produto Recebimento HTTP ${Date.now()}`, categoria: "Vestidos", precoCusto: valorItem / 2, precoVenda: valorItem, ehNovidade: false }, null);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Preto" }, null);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanho: "M", delta: 5, exigirExistente: false });
    const vendedor = await vendedoresService.criar({ nome: "Vendedora Recebimento HTTP", telefone: telefoneUnico(), ativo: true, senha: "senha123" }, null);
    const cliente = await clientesService.criar({ nome: "Cliente Recebimento HTTP", telefone: telefoneUnico() }, null);
    const caixaAtual = await caixasService.obterAtual();
    if (!caixaAtual) throw new Error("Nenhum caixa aberto — o seed de beforeAll deveria manter um aberto.");
    const venda = await vendasService.criar(
      {
        clienteId: cliente.id,
        vendedorId: vendedor.id,
        caixaId: caixaAtual.id,
        itens: [{ produtoId: produto.id, varianteId: String(variante._id), tamanhoId, quantidade: 1 }],
        pagamentos: valorPagoNaCriacao > 0 ? [{ forma: "Dinheiro", valor: valorPagoNaCriacao }] : [],
      },
      null,
    );
    return { venda, caixa: caixaAtual };
  }

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: validationExceptionFactory,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });

    const swaggerConfig = new DocumentBuilder().setTitle("MARIELA API").addBearerAuth().build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));

    await app.init();
    await app.listen(0);
    const endereco = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${endereco.port}`;
    connection = app.get(getConnectionToken());

    const authService = app.get(AuthService);
    const email = `teste.http.vendas.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Vendas", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;

    // Seed via mecanismo interno — nunca via HTTP (não existe rota de criação).
    produtosService = app.get(ProdutosService);
    vendedoresService = app.get(VendedoresService);
    clientesService = app.get(ClientesService);
    caixasService = app.get(CaixasService);
    vendasService = app.get(VendasService);
    adquirentesService = app.get(AdquirentesService);

    const produto = await produtosService.criar({ nome: "Produto HTTP Vendas", categoria: "Vestidos", precoCusto: 100, precoVenda: 200, ehNovidade: false }, null);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Verde" }, null);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanho: "G", delta: 10, exigirExistente: false });
    const vendedor = await vendedoresService.criar({ nome: "Vendedora HTTP", telefone: telefoneUnico(), ativo: true, senha: "senha123" }, null);
    // Venda seedada fica com saldo pendente (pagamento 100 < valorFinal 200) —
    // exige clienteId desde a Etapa 10.7 (venda fiada nunca para Consumidor final).
    const cliente = await clientesService.criar({ nome: "Cliente HTTP Vendas", telefone: telefoneUnico() }, null);
    const caixa = await caixasService.abrir({ valorInicial: 500, observacao: "" }, null);
    caixaId = caixa.id;

    const venda = await vendasService.criar(
      {
        clienteId: cliente.id,
        vendedorId: vendedor.id,
        caixaId: caixa.id,
        itens: [{ produtoId: produto.id, varianteId: String(variante._id), tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      },
      null,
    );
    vendaId = venda.id;
    vendaCodigo = venda.codigo;
    parcelaId = String(venda.parcelas[0]!._id);
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
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["venda", "produto", "vendedor", "cliente", "caixa", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /api/v1/vendas SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas`);
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/vendas lista a venda seedada com paginação e facetas", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas?busca=${encodeURIComponent(vendaCodigo)}&page=1&limit=20`, { headers: authHeaders() });
    const corpo = (await resposta.json()) as {
      data: unknown[];
      meta: { total: number; page: number; limit: number; totalPages: number };
      facets: Record<string, unknown>;
    };
    expect(resposta.status).toBe(200);
    expect(corpo.data).toHaveLength(1);
    expect(corpo.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(corpo.facets["status"]).toBeTruthy();
  });

  it("GET /api/v1/vendas/estatisticas retorna as métricas agregadas", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas/estatisticas`, { headers: authHeaders() });
    const corpo = (await resposta.json()) as { data: { totalVendas: number } };
    expect(resposta.status).toBe(200);
    expect(corpo.data.totalVendas).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/v1/vendas/:id retorna o detalhe completo", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas/${vendaId}`, { headers: authHeaders() });
    const corpo = (await resposta.json()) as { data: { codigo: string; status: string; itens: unknown[]; parcelas: unknown[] } };
    expect(resposta.status).toBe(200);
    expect(corpo.data.codigo).toBe(vendaCodigo);
    expect(corpo.data.status).toBe("em_pagamento");
    expect(corpo.data.itens).toHaveLength(1);
    expect(corpo.data.parcelas).toHaveLength(1);
  });

  it("GET /api/v1/vendas/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: authHeaders() });
    expect(resposta.status).toBe(404);
  });

  it("POST /api/v1/vendas/:id/parcelas/:parcelaId/baixa quita a parcela e reflete no caixa", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas/${vendaId}/parcelas/${parcelaId}/baixa`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ formaPagamento: "PIX" }),
    });
    const corpo = (await resposta.json()) as { data: { status: string; valorPendente: number } };
    expect(resposta.status).toBe(201);
    expect(corpo.data.status).toBe("concluida");
    expect(corpo.data.valorPendente).toBe(0);

    const detalheCaixa = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}`, { headers: authHeaders() });
    const corpoCaixa = (await detalheCaixa.json()) as { data: { resumo: { recebimentos: number } } };
    expect(corpoCaixa.data.resumo.recebimentos).toBe(100);
  });

  it("POST .../parcelas/:parcelaId/baixa numa parcela já paga retorna 400", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas/${vendaId}/parcelas/${parcelaId}/baixa`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(resposta.status).toBe(400);
  });

  it("POST /api/v1/vendas/:id/cancelamento com motivo vazio retorna 400", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas/${vendaId}/cancelamento`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ tipo: "integral", motivo: "" }),
    });
    expect(resposta.status).toBe(400);
  });

  it("POST /api/v1/vendas/:id/cancelamento cancela a venda e devolve o estoque", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas/${vendaId}/cancelamento`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ tipo: "integral", motivo: "Cancelamento de teste HTTP" }),
    });
    const corpo = (await resposta.json()) as { data: { status: string; cancelamento: { tipo: string } | null } };
    expect(resposta.status).toBe(201);
    expect(corpo.data.status).toBe("cancelada");
    expect(corpo.data.cancelamento?.tipo).toBe("integral");
  });

  describe("POST /api/v1/vendas/:id/recebimentos (Etapa 10.8)", () => {
    it("SEM token retorna 401", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/vendas/${vendaId}/recebimentos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forma: "Dinheiro", valor: 10 }),
      });
      expect(resposta.status).toBe(401);
    });

    it("recebimento parcial reduz o pendente e reflete no caixa como recebimento", async () => {
      const { venda, caixa } = await criarVendaFiadaViaHttpSetup(1000, 400);
      const antes = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}`, { headers: authHeaders() });
      const corpoAntes = (await antes.json()) as { data: { resumo: { recebimentos: number } } };

      const resposta = await fetch(`${baseUrl}/api/v1/vendas/${venda.id}/recebimentos`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ forma: "Dinheiro", valor: 250 }),
      });
      expect(resposta.status).toBe(201);
      const corpo = (await resposta.json()) as { data: { valorPago: number; valorPendente: number; status: string } };
      expect(corpo.data.valorPago).toBe(650);
      expect(corpo.data.valorPendente).toBe(350);
      expect(corpo.data.status).toBe("em_pagamento");

      const depois = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}`, { headers: authHeaders() });
      const corpoDepois = (await depois.json()) as { data: { resumo: { recebimentos: number } } };
      expect(corpoDepois.data.resumo.recebimentos - corpoAntes.data.resumo.recebimentos).toBe(250);
    });

    it("recebimento que quita exatamente o saldo conclui a venda", async () => {
      const { venda } = await criarVendaFiadaViaHttpSetup(500, 300);
      const resposta = await fetch(`${baseUrl}/api/v1/vendas/${venda.id}/recebimentos`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ forma: "PIX", valor: 200 }),
      });
      expect(resposta.status).toBe(201);
      const corpo = (await resposta.json()) as { data: { status: string; valorPendente: number } };
      expect(corpo.data.status).toBe("concluida");
      expect(corpo.data.valorPendente).toBe(0);
    });

    it("recebimento acima do saldo pendente retorna 400 sem alterar a venda", async () => {
      const { venda } = await criarVendaFiadaViaHttpSetup(500, 300);
      const resposta = await fetch(`${baseUrl}/api/v1/vendas/${venda.id}/recebimentos`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ forma: "Dinheiro", valor: 201 }),
      });
      const corpo = (await resposta.json()) as { code: string };
      expect(resposta.status).toBe(400);
      expect(corpo.code).toBe("VALIDATION_ERROR");

      const detalhe = await fetch(`${baseUrl}/api/v1/vendas/${venda.id}`, { headers: authHeaders() });
      const corpoDetalhe = (await detalhe.json()) as { data: { valorPago: number; valorPendente: number } };
      expect(corpoDetalhe.data.valorPago).toBe(300);
      expect(corpoDetalhe.data.valorPendente).toBe(200);
    });

    it("recebimento em crédito com adquirente calcula tarifa e usa o valor bruto no caixa", async () => {
      const adquirente = await adquirentesService.criar({ nome: `Adquirente Recebimento HTTP ${Date.now()}`, tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 4 }] }, null);
      const { venda, caixa } = await criarVendaFiadaViaHttpSetup(500, 300);
      const antes = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}`, { headers: authHeaders() });
      const corpoAntes = (await antes.json()) as { data: { resumo: { recebimentos: number } } };

      const resposta = await fetch(`${baseUrl}/api/v1/vendas/${venda.id}/recebimentos`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ forma: "Crédito", modalidade: "credito", adquirenteId: adquirente.id, parcelas: 1, valor: 200 }),
      });
      expect(resposta.status).toBe(201);
      const corpo = (await resposta.json()) as {
        data: { valorPago: number; pagamentos: { valor: number; tarifaAplicada: { valorTarifa: number; valorBruto: number } | null }[] };
      };
      const recebido = corpo.data.pagamentos[corpo.data.pagamentos.length - 1]!;
      expect(recebido.tarifaAplicada?.valorBruto).toBe(200);
      expect(recebido.tarifaAplicada?.valorTarifa).toBe(8);
      expect(corpo.data.valorPago).toBe(500); // bruto, nunca 300+192

      const depois = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}`, { headers: authHeaders() });
      const corpoDepois = (await depois.json()) as { data: { resumo: { recebimentos: number } } };
      expect(corpoDepois.data.resumo.recebimentos - corpoAntes.data.resumo.recebimentos).toBe(200); // bruto, nunca 192
    });

    it("retry com a mesma idempotencyKey não duplica o recebimento nem o movimento de caixa", async () => {
      const { venda, caixa } = await criarVendaFiadaViaHttpSetup(500, 300);
      const chave = `recebimento-http-idem-${Date.now()}`;
      const payload = JSON.stringify({ forma: "Dinheiro", valor: 100, idempotencyKey: chave });
      const antes = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}`, { headers: authHeaders() });
      const corpoAntes = (await antes.json()) as { data: { resumo: { recebimentos: number } } };

      const primeira = await fetch(`${baseUrl}/api/v1/vendas/${venda.id}/recebimentos`, { method: "POST", headers: authHeaders(), body: payload });
      const segunda = await fetch(`${baseUrl}/api/v1/vendas/${venda.id}/recebimentos`, { method: "POST", headers: authHeaders(), body: payload });
      expect(primeira.status).toBe(201);
      expect(segunda.status).toBe(201);
      const corpoSegunda = (await segunda.json()) as { data: { valorPago: number } };
      expect(corpoSegunda.data.valorPago).toBe(400); // não virou 500

      const depois = await fetch(`${baseUrl}/api/v1/caixas/${caixa.id}`, { headers: authHeaders() });
      const corpoDepois = (await depois.json()) as { data: { resumo: { recebimentos: number } } };
      expect(corpoDepois.data.resumo.recebimentos - corpoAntes.data.resumo.recebimentos).toBe(100); // não duplicou no caixa
    });

    it("recebimento em venda CANCELADA retorna 400", async () => {
      const { venda } = await criarVendaFiadaViaHttpSetup(500, 300);
      await vendasService.cancelar(venda.id, { tipo: "integral", motivo: "Teste HTTP 10.8" }, null);

      const resposta = await fetch(`${baseUrl}/api/v1/vendas/${venda.id}/recebimentos`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ forma: "Dinheiro", valor: 50 }),
      });
      expect(resposta.status).toBe(400);
    });

    it("payload sem forma/valor é rejeitado pelo ValidationPipe (400)", async () => {
      const { venda } = await criarVendaFiadaViaHttpSetup(500, 300);
      const resposta = await fetch(`${baseUrl}/api/v1/vendas/${venda.id}/recebimentos`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(resposta.status).toBe(400);
    });
  });

  it("não existe POST /api/v1/vendas (criação é exclusiva do mecanismo interno/futuro PDV)", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(resposta.status).toBe(404);
  });

  it("GET /docs-json documenta só as rotas de consulta/administração de Vendas — sem POST /vendas", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/vendas",
        "/api/v1/vendas/estatisticas",
        "/api/v1/vendas/{id}",
        "/api/v1/vendas/{id}/parcelas/{parcelaId}/baixa",
        "/api/v1/vendas/{id}/recebimentos",
        "/api/v1/vendas/{id}/cancelamento",
      ]),
    );
    expect(documento.paths["/api/v1/vendas"]?.["post"]).toBeUndefined();
  });
});
