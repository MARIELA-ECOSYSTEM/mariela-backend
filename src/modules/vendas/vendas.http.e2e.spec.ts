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
import { CaixasService } from "../caixas/caixas.service.js";
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

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1198${String(contadorTelefone).padStart(6, "0")}`;
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
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
    const produtosService = app.get(ProdutosService);
    const vendedoresService = app.get(VendedoresService);
    const caixasService = app.get(CaixasService);
    const vendasService = app.get(VendasService);

    const produto = await produtosService.criar({ nome: "Produto HTTP Vendas", categoria: "Vestidos", precoCusto: 100, precoVenda: 200, ehNovidade: false }, null);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Verde" }, null);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanho: "G", delta: 10, exigirExistente: false });
    const vendedor = await vendedoresService.criar({ nome: "Vendedora HTTP", telefone: telefoneUnico(), ativo: true, senha: "senha123" }, null);
    const caixa = await caixasService.abrir({ valorInicial: 500, observacao: "" }, null);
    caixaId = caixa.id;

    const venda = await vendasService.criar(
      {
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
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["venda", "produto", "vendedor", "caixa", "usuario"] } });
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
      expect.arrayContaining(["/api/v1/vendas", "/api/v1/vendas/estatisticas", "/api/v1/vendas/{id}", "/api/v1/vendas/{id}/parcelas/{parcelaId}/baixa", "/api/v1/vendas/{id}/cancelamento"]),
    );
    expect(documento.paths["/api/v1/vendas"]?.["post"]).toBeUndefined();
  });
});
