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
import { VendedoresService } from "../vendedores/vendedores.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global) — mesmo padrão de
 * `colecoes.http.e2e.spec.ts`, aplicado ao CRUD de Adquirentes.
 */
describe("HTTP — Adquirentes (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1193${String(contadorTelefone).padStart(6, "0")}`;
  }

  function jsonHeaders(token?: string): Record<string, string> {
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
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
    const email = `teste.http.adquirentes.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Adquirentes", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("adquirentes").deleteMany({});
    await connection.collection("eventos_adquirente").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["vendedor", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  async function criarELogarVendedor(): Promise<string> {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await vendedoresService.criar(
      { nome: "Vendedora HTTP Adquirentes", telefone: telefoneUnico(), ativo: true, senha: "senha123" },
      null,
    );

    const respostaLogin = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }),
    });
    const corpo = (await respostaLogin.json()) as { data: { accessToken: string } };
    return corpo.data.accessToken;
  }

  it("GET /api/v1/adquirentes SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/adquirentes`);
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/adquirentes com token de VENDEDOR (PDV) é rejeitado", async () => {
    const tokenVendedor = await criarELogarVendedor();
    const resposta = await fetch(`${baseUrl}/api/v1/adquirentes`, { headers: jsonHeaders(tokenVendedor) });
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/adquirentes com payload inválido retorna 400 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/adquirentes`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ nome: "" }),
    });
    const corpo = (await resposta.json()) as { statusCode: number; code: string; errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
    expect(corpo.errors.some((erro) => erro.field === "nome")).toBe(true);
  });

  it("fluxo completo: criar → obter → listar (busca/paginação) → atualizar (PATCH parcial) → excluir → 404", async () => {
    const nome = `Adquirente E2E ${Date.now()}`;

    const criacao = await fetch(`${baseUrl}/api/v1/adquirentes`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({
        nome,
        observacao: "Recebimento D+1",
        tabelaTarifas: [
          { modalidade: "debito", parcelas: 1, percentual: 1.99 },
          { modalidade: "credito", parcelas: 1, percentual: 3.49 },
          { modalidade: "credito", parcelas: 6, percentual: 5.99 },
        ],
      }),
    });
    expect(criacao.status).toBe(201);
    const corpoCriacao = (await criacao.json()) as {
      data: { id: string; nome: string; ativo: boolean; observacao: string; tabelaTarifas: unknown[]; excluidoEm: null };
    };
    const adquirenteId = corpoCriacao.data.id;
    expect(corpoCriacao.data.nome).toBe(nome);
    expect(corpoCriacao.data.ativo).toBe(true);
    expect(corpoCriacao.data.tabelaTarifas).toHaveLength(3);
    expect(corpoCriacao.data.excluidoEm).toBeNull();

    const obtido = await fetch(`${baseUrl}/api/v1/adquirentes/${adquirenteId}`, { headers: jsonHeaders(adminAccessToken) });
    expect(obtido.status).toBe(200);

    const listagem = await fetch(`${baseUrl}/api/v1/adquirentes?busca=${encodeURIComponent(nome)}&page=1&limit=20`, {
      headers: jsonHeaders(adminAccessToken),
    });
    const corpoListagem = (await listagem.json()) as {
      data: unknown[];
      meta: { total: number; page: number; limit: number; totalPages: number };
    };
    expect(listagem.status).toBe(200);
    expect(corpoListagem.data).toHaveLength(1);
    expect(corpoListagem.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });

    // PATCH parcial: só `ativo` — nome e tabela de tarifas devem permanecer intactos.
    const atualizacao = await fetch(`${baseUrl}/api/v1/adquirentes/${adquirenteId}`, {
      method: "PATCH",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ ativo: false }),
    });
    const corpoAtualizacao = (await atualizacao.json()) as {
      data: { nome: string; ativo: boolean; tabelaTarifas: unknown[] };
    };
    expect(atualizacao.status).toBe(200);
    expect(corpoAtualizacao.data.ativo).toBe(false);
    expect(corpoAtualizacao.data.nome).toBe(nome);
    expect(corpoAtualizacao.data.tabelaTarifas).toHaveLength(3);

    const exclusao = await fetch(`${baseUrl}/api/v1/adquirentes/${adquirenteId}`, {
      method: "DELETE",
      headers: jsonHeaders(adminAccessToken),
    });
    expect(exclusao.status).toBe(200);

    const apos = await fetch(`${baseUrl}/api/v1/adquirentes/${adquirenteId}`, { headers: jsonHeaders(adminAccessToken) });
    expect(apos.status).toBe(404);

    const listaApos = await fetch(`${baseUrl}/api/v1/adquirentes?busca=${encodeURIComponent(nome)}`, {
      headers: jsonHeaders(adminAccessToken),
    });
    const corpoListaApos = (await listaApos.json()) as { data: unknown[] };
    expect(corpoListaApos.data).toHaveLength(0);
  });

  it("POST /api/v1/adquirentes com nome duplicado (case-insensitive) retorna 409", async () => {
    const nome = `Adquirente Duplicada HTTP ${Date.now()}`;
    const primeira = await fetch(`${baseUrl}/api/v1/adquirentes`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ nome }),
    });
    expect(primeira.status).toBe(201);

    const segunda = await fetch(`${baseUrl}/api/v1/adquirentes`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ nome: nome.toUpperCase() }),
    });
    const corpo = (await segunda.json()) as { code: string };
    expect(segunda.status).toBe(409);
    expect(corpo.code).toBe("CONFLICT");
  });

  it("POST /api/v1/adquirentes com débito de 2 parcelas retorna 400", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/adquirentes`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({
        nome: `Adquirente Débito Inválido ${Date.now()}`,
        tabelaTarifas: [{ modalidade: "debito", parcelas: 2, percentual: 1.99 }],
      }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
  });

  it("GET /api/v1/adquirentes/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/adquirentes/65f1a2b3c4d5e6f7a8b9c0d1`, {
      headers: jsonHeaders(adminAccessToken),
    });
    expect(resposta.status).toBe(404);
  });

  it("GET /docs-json documenta as rotas de Adquirentes com BearerAuth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining(["/api/v1/adquirentes", "/api/v1/adquirentes/{id}"]),
    );
  });
});
