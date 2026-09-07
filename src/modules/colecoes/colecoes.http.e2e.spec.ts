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
 * exceções, mesmo prefixo global) — mesmo padrão de
 * `fornecedores.http.e2e.spec.ts`, aplicado ao CRUD de Coleções.
 */
describe("HTTP — Coleções (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;

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
    const email = `teste.http.colecoes.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Coleções", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("colecoes").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_colecao").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["colecao", "produto", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /api/v1/colecoes SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/colecoes`);
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/colecoes com payload inválido retorna 400 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/colecoes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "" }),
    });
    const corpo = (await resposta.json()) as { statusCode: number; code: string; errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
    expect(corpo.errors.some((erro) => erro.field === "nome")).toBe(true);
  });

  it("fluxo completo: criar → obter → listar (paginação/busca) → status → atualizar → excluir → 404", async () => {
    const nome = `Coleção E2E ${Date.now()}`;

    const criacao = await fetch(`${baseUrl}/api/v1/colecoes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome, inicio: "2026-01-01", fim: "2026-03-31" }),
    });
    expect(criacao.status).toBe(201);
    const corpoCriacao = (await criacao.json()) as { data: { id: string; codigo: string } };
    const colecaoId = corpoCriacao.data.id;
    expect(corpoCriacao.data.codigo).toMatch(/^COL-\d{4}$/);

    const obtido = await fetch(`${baseUrl}/api/v1/colecoes/${colecaoId}`, { headers: authHeaders() });
    expect(obtido.status).toBe(200);

    const listagem = await fetch(`${baseUrl}/api/v1/colecoes?busca=${encodeURIComponent(nome)}&page=1&limit=20`, {
      headers: authHeaders(),
    });
    const corpoListagem = (await listagem.json()) as {
      data: unknown[];
      meta: { total: number; page: number; limit: number; totalPages: number };
      facets: Record<string, { valor: string; count: number }[]>;
    };
    expect(listagem.status).toBe(200);
    expect(corpoListagem.data).toHaveLength(1);
    expect(corpoListagem.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(corpoListagem.facets["situacao"]).toBeTruthy();

    const produtosVinculados = await fetch(`${baseUrl}/api/v1/colecoes/${colecaoId}/produtos`, { headers: authHeaders() });
    const corpoProdutos = (await produtosVinculados.json()) as { data: unknown[] };
    expect(produtosVinculados.status).toBe(200);
    expect(corpoProdutos.data).toEqual([]);

    const status = await fetch(`${baseUrl}/api/v1/colecoes/${colecaoId}/status`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ ativo: false }),
    });
    const corpoStatus = (await status.json()) as { data: { ativo: boolean } };
    expect(status.status).toBe(200);
    expect(corpoStatus.data.ativo).toBe(false);

    const atualizacao = await fetch(`${baseUrl}/api/v1/colecoes/${colecaoId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ nome: `${nome} Atualizada`, inicio: "2026-01-01", fim: "2026-03-31", ativo: true }),
    });
    const corpoAtualizacao = (await atualizacao.json()) as { data: { nome: string; ativo: boolean } };
    expect(atualizacao.status).toBe(200);
    expect(corpoAtualizacao.data.nome).toBe(`${nome} Atualizada`);
    expect(corpoAtualizacao.data.ativo).toBe(true);

    const exclusao = await fetch(`${baseUrl}/api/v1/colecoes/${colecaoId}`, { method: "DELETE", headers: authHeaders() });
    expect(exclusao.status).toBe(200);

    const apos = await fetch(`${baseUrl}/api/v1/colecoes/${colecaoId}`, { headers: authHeaders() });
    expect(apos.status).toBe(404);

    const listaApos = await fetch(`${baseUrl}/api/v1/colecoes?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
    const corpoListaApos = (await listaApos.json()) as { data: unknown[] };
    expect(corpoListaApos.data).toHaveLength(0);
  });

  it("POST /api/v1/colecoes com fim anterior ao início retorna 400", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/colecoes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Coleção Inválida", inicio: "2026-06-01", fim: "2026-01-01" }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
  });

  it("DELETE bloqueia exclusão quando há produtos vinculados (400)", async () => {
    const criacao = await fetch(`${baseUrl}/api/v1/colecoes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Coleção Com Produto", inicio: "2026-01-01", fim: "2026-03-31" }),
    });
    const { data: colecao } = (await criacao.json()) as { data: { id: string } };

    await fetch(`${baseUrl}/api/v1/produtos`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        nome: "Produto Vinculado E2E",
        categoria: "Vestidos",
        colecaoId: colecao.id,
        precoCusto: 50,
        precoVenda: 100,
      }),
    });

    const exclusao = await fetch(`${baseUrl}/api/v1/colecoes/${colecao.id}`, { method: "DELETE", headers: authHeaders() });
    const corpo = (await exclusao.json()) as { code: string };
    expect(exclusao.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
  });

  it("GET /api/v1/colecoes/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/colecoes/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: authHeaders() });
    expect(resposta.status).toBe(404);
  });

  it("GET /docs-json documenta as rotas de Coleções com BearerAuth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/colecoes",
        "/api/v1/colecoes/{id}",
        "/api/v1/colecoes/{id}/produtos",
        "/api/v1/colecoes/{id}/status",
      ]),
    );
  });
});
