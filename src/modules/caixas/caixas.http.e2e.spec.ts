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

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global) — mesmo padrão de `clientes.http.e2e.spec.ts`,
 * aplicado ao ciclo completo de Caixa.
 */
describe("HTTP — Caixas (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  }

  async function fecharTudoQueEstiverAberto(): Promise<void> {
    await connection.collection("caixas").updateMany({ status: "aberto" }, { $set: { status: "fechado" } });
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
    const email = `teste.http.caixas.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Caixas", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["caixa", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /api/v1/caixas SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/caixas`);
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/caixas com payload inválido retorna 400 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/caixas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInicial: -10 }),
    });
    const corpo = (await resposta.json()) as { code: string; errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
    expect(corpo.errors.some((erro) => erro.field === "valorInicial")).toBe(true);
  });

  it("GET /api/v1/caixas/atual retorna null quando não há caixa aberto", async () => {
    await fecharTudoQueEstiverAberto();
    const resposta = await fetch(`${baseUrl}/api/v1/caixas/atual`, { headers: authHeaders() });
    const corpo = (await resposta.json()) as { data: unknown };
    expect(resposta.status).toBe(200);
    expect(corpo.data).toBeNull();
  });

  it("fluxo completo: abrir → atual → entrada → saída → movimentações → fechamento → 409 dupla abertura → nova operação após fechado falha", async () => {
    const abertura = await fetch(`${baseUrl}/api/v1/caixas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInicial: 200 }),
    });
    expect(abertura.status).toBe(201);
    const corpoAbertura = (await abertura.json()) as { data: { id: string; codigo: string; resumo: { saldoEsperado: number } } };
    const caixaId = corpoAbertura.data.id;
    expect(corpoAbertura.data.codigo).toMatch(/^CAIXA-\d{4}$/);
    expect(corpoAbertura.data.resumo.saldoEsperado).toBe(200);

    const duplaAbertura = await fetch(`${baseUrl}/api/v1/caixas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInicial: 50 }),
    });
    expect(duplaAbertura.status).toBe(409);

    const atual = await fetch(`${baseUrl}/api/v1/caixas/atual`, { headers: authHeaders() });
    const corpoAtual = (await atual.json()) as { data: { id: string } };
    expect(atual.status).toBe(200);
    expect(corpoAtual.data.id).toBe(caixaId);

    const entrada = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/entrada`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ descricao: "Suprimento", valor: 100, formaPagamento: "Dinheiro" }),
    });
    const corpoEntrada = (await entrada.json()) as { data: { resumo: { saldoEsperado: number } } };
    expect(entrada.status).toBe(201);
    expect(corpoEntrada.data.resumo.saldoEsperado).toBe(300);

    const saidaExcedente = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/saida`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ descricao: "Retirada grande", valor: 1000, formaPagamento: "Dinheiro", motivo: "Teste" }),
    });
    expect(saidaExcedente.status).toBe(400);

    const saida = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/saida`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ descricao: "Compra", valor: 50, formaPagamento: "Dinheiro", motivo: "Material" }),
    });
    const corpoSaida = (await saida.json()) as { data: { resumo: { saldoEsperado: number } } };
    expect(saida.status).toBe(201);
    expect(corpoSaida.data.resumo.saldoEsperado).toBe(250);

    const movimentacoes = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/movimentacoes?page=1&limit=20`, {
      headers: authHeaders(),
    });
    const corpoMovimentacoes = (await movimentacoes.json()) as { data: unknown[]; meta: { total: number } };
    expect(movimentacoes.status).toBe(200);
    expect(corpoMovimentacoes.meta.total).toBe(2);

    const vendas = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/vendas`, { headers: authHeaders() });
    const corpoVendas = (await vendas.json()) as { data: unknown[] };
    expect(vendas.status).toBe(200);
    expect(corpoVendas.data).toEqual([]);

    const fechamentoSemObservacao = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/fechamento`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInformado: 200 }),
    });
    expect(fechamentoSemObservacao.status).toBe(400);

    const fechamento = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/fechamento`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInformado: 250 }),
    });
    const corpoFechamento = (await fechamento.json()) as { data: { status: string; fechamento: { diferenca: number } } };
    expect(fechamento.status).toBe(201);
    expect(corpoFechamento.data.status).toBe("fechado");
    expect(corpoFechamento.data.fechamento.diferenca).toBe(0);

    const entradaAposFechado = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/entrada`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ descricao: "Tarde demais", valor: 10, formaPagamento: "Dinheiro" }),
    });
    expect(entradaAposFechado.status).toBe(400);

    // Fechar de novo (sequencial, não concorrente) cai na checagem de estado
    // ("está fechado e é imutável" → 400) antes de chegar na guarda atômica de
    // corrida (essa só devolve 409 quando duas chamadas realmente concorrem —
    // ver `caixas.service.spec.ts`, "rejeita fechar um caixa já fechado").
    const fechamentoDuplicado = await fetch(`${baseUrl}/api/v1/caixas/${caixaId}/fechamento`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ valorInformado: 250 }),
    });
    expect(fechamentoDuplicado.status).toBe(400);
  });

  it("GET /api/v1/caixas com paginação e busca encontra o caixa pelo código", async () => {
    const caixas = await connection.collection("caixas").find().sort({ criadoEm: -1 }).limit(1).toArray();
    const codigo = caixas[0]?.["codigo"] as string;
    const listagem = await fetch(`${baseUrl}/api/v1/caixas?busca=${encodeURIComponent(codigo)}&page=1&limit=20`, {
      headers: authHeaders(),
    });
    const corpo = (await listagem.json()) as {
      data: unknown[];
      meta: { total: number; page: number; limit: number; totalPages: number };
      facets: Record<string, unknown>;
    };
    expect(listagem.status).toBe(200);
    expect(corpo.data).toHaveLength(1);
    expect(corpo.facets["status"]).toBeTruthy();
  });

  it("GET /api/v1/caixas/estatisticas retorna as contagens agregadas", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/caixas/estatisticas`, { headers: authHeaders() });
    const corpo = (await resposta.json()) as { data: { caixasFechados: number } };
    expect(resposta.status).toBe(200);
    expect(corpo.data.caixasFechados).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/v1/caixas/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/caixas/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: authHeaders() });
    expect(resposta.status).toBe(404);
  });

  it("GET /docs-json documenta as rotas de Caixas com BearerAuth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/caixas",
        "/api/v1/caixas/atual",
        "/api/v1/caixas/estatisticas",
        "/api/v1/caixas/{id}",
        "/api/v1/caixas/{id}/movimentacoes",
        "/api/v1/caixas/{id}/vendas",
        "/api/v1/caixas/{id}/recebimentos",
        "/api/v1/caixas/{id}/entrada",
        "/api/v1/caixas/{id}/saida",
        "/api/v1/caixas/{id}/fechamento",
      ]),
    );
  });
});
