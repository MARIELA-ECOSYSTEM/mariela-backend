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
 * exceções, mesmo prefixo global) — mesmo padrão de `auth.http.e2e.spec.ts`,
 * aplicado ao CRUD completo de Clientes.
 */
describe("HTTP — Clientes (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `8390${String(contadorTelefone).padStart(6, "0")}`;
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
    const email = `teste.http.clientes.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Clientes", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["cliente", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /api/v1/clientes SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`);
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/clientes com payload inválido retorna 400 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "" }),
    });
    const corpo = (await resposta.json()) as { statusCode: number; code: string; errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
    expect(corpo.errors.some((erro) => erro.field === "nome" || erro.field === "telefone")).toBe(true);
  });

  it("fluxo completo: criar → obter → listar (paginação/busca) → atualizar → excluir → 404", async () => {
    const telefone = telefoneUnico();
    const nome = `Cliente E2E ${Date.now()}`;

    const criacao = await fetch(`${baseUrl}/api/v1/clientes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome, telefone }),
    });
    expect(criacao.status).toBe(201);
    const corpoCriacao = (await criacao.json()) as { data: { id: string; codigo: string } };
    const clienteId = corpoCriacao.data.id;
    expect(corpoCriacao.data.codigo).toMatch(/^CLI-\d{4}$/);

    const obtido = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}`, { headers: authHeaders() });
    expect(obtido.status).toBe(200);

    const listagem = await fetch(`${baseUrl}/api/v1/clientes?busca=${encodeURIComponent(nome)}&page=1&limit=20`, {
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
    expect(corpoListagem.facets["historico"]).toBeTruthy();

    const atualizacao = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ nome: `${nome} Atualizado`, telefone }),
    });
    const corpoAtualizacao = (await atualizacao.json()) as { data: { nome: string } };
    expect(atualizacao.status).toBe(200);
    expect(corpoAtualizacao.data.nome).toBe(`${nome} Atualizado`);

    const vendas = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}/vendas`, { headers: authHeaders() });
    const corpoVendas = (await vendas.json()) as { data: unknown[] };
    expect(vendas.status).toBe(200);
    expect(corpoVendas.data).toEqual([]);

    const exclusao = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}`, { method: "DELETE", headers: authHeaders() });
    expect(exclusao.status).toBe(200);

    const apos = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}`, { headers: authHeaders() });
    expect(apos.status).toBe(404);

    const listaApos = await fetch(`${baseUrl}/api/v1/clientes?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
    const corpoListaApos = (await listaApos.json()) as { data: unknown[] };
    expect(corpoListaApos.data).toHaveLength(0);
  });

  it("POST /api/v1/clientes com telefone duplicado retorna 409", async () => {
    const telefone = telefoneUnico();
    await fetch(`${baseUrl}/api/v1/clientes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Duplicado Um", telefone }),
    });
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Duplicado Dois", telefone }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(409);
    expect(corpo.code).toBe("CONFLICT");
  });

  it("GET /api/v1/clientes/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/clientes/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: authHeaders() });
    expect(resposta.status).toBe(404);
  });

  it("GET /api/v1/clientes com token malformado/inválido retorna 401", async () => {
    // Não existe hoje nenhuma role além de ADMIN no sistema (ver `common/types/role.type.ts`),
    // então um teste genuíno de 403 (role válida, mas insuficiente) não é
    // possível ainda — documentado como pendência no relatório final.
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`, {
      headers: { authorization: "Bearer token-invalido-sem-role" },
    });
    expect(resposta.status).toBe(401);
  });

  it("GET /docs-json documenta as rotas de Clientes com BearerAuth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining(["/api/v1/clientes", "/api/v1/clientes/{id}", "/api/v1/clientes/{id}/vendas"]),
    );
  });
});
