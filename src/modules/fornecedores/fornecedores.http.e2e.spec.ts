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
 * `clientes.http.e2e.spec.ts`, aplicado ao CRUD de Fornecedores.
 */
describe("HTTP — Fornecedores (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1197${String(contadorTelefone).padStart(6, "0")}`;
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
    const email = `teste.http.fornecedores.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Fornecedores", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("fornecedores").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_fornecedor").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["fornecedor", "produto", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /api/v1/fornecedores SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/fornecedores`);
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/fornecedores com payload inválido retorna 400 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/fornecedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "" }),
    });
    const corpo = (await resposta.json()) as { statusCode: number; code: string; errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
    expect(corpo.errors.some((erro) => erro.field === "nome")).toBe(true);
  });

  it("fluxo completo: criar → obter → listar (paginação/busca) → atualizar → excluir → 404", async () => {
    const telefone = telefoneUnico();
    const nome = `Fornecedor E2E ${Date.now()}`;

    const criacao = await fetch(`${baseUrl}/api/v1/fornecedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome, telefone, cnpj: "12.345.678/0001-99" }),
    });
    expect(criacao.status).toBe(201);
    const corpoCriacao = (await criacao.json()) as { data: { id: string; codigo: string } };
    const fornecedorId = corpoCriacao.data.id;
    expect(corpoCriacao.data.codigo).toMatch(/^FOR-\d{4}$/);

    const obtido = await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedorId}`, { headers: authHeaders() });
    expect(obtido.status).toBe(200);

    const listagem = await fetch(`${baseUrl}/api/v1/fornecedores?busca=${encodeURIComponent(nome)}&page=1&limit=20`, {
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
    expect(corpoListagem.facets["produtos"]).toBeTruthy();

    const historico = await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedorId}/historico`, { headers: authHeaders() });
    const corpoHistorico = (await historico.json()) as { data: unknown[] };
    expect(historico.status).toBe(200);
    expect(corpoHistorico.data).toEqual([]);

    const atualizacao = await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedorId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ nome: `${nome} Atualizado`, telefone }),
    });
    const corpoAtualizacao = (await atualizacao.json()) as { data: { nome: string } };
    expect(atualizacao.status).toBe(200);
    expect(corpoAtualizacao.data.nome).toBe(`${nome} Atualizado`);

    const exclusao = await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedorId}`, { method: "DELETE", headers: authHeaders() });
    expect(exclusao.status).toBe(200);

    const apos = await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedorId}`, { headers: authHeaders() });
    expect(apos.status).toBe(404);

    const listaApos = await fetch(`${baseUrl}/api/v1/fornecedores?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
    const corpoListaApos = (await listaApos.json()) as { data: unknown[] };
    expect(corpoListaApos.data).toHaveLength(0);
  });

  describe("GET /fornecedores: contrato duplo retrocompatível (Etapa 14.2)", () => {
    it("SEM nenhum query param: devolve o array COMPLETO de fornecedores ativos, sem meta/facets (contrato legado do Backoffice)", async () => {
      const nome = `Legado ${Date.now()}`;
      const criacao = await fetch(`${baseUrl}/api/v1/fornecedores`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico() }),
      });
      const fornecedorId = ((await criacao.json()) as { data: { id: string } }).data.id;

      const resposta = await fetch(`${baseUrl}/api/v1/fornecedores`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { id: string; nome: string }[]; meta?: unknown; facets?: unknown };
      expect(Array.isArray(corpo.data)).toBe(true);
      expect(corpo.meta).toBeUndefined();
      expect(corpo.facets).toBeUndefined();
      expect(corpo.data.some((fornecedor) => fornecedor.id === fornecedorId)).toBe(true);
    });

    it("COM page/limit: preserva o contrato paginado/facetado já existente", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/fornecedores?page=1&limit=1`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: unknown[]; meta: { total: number; page: number; limit: number }; facets: Record<string, unknown> };
      expect(corpo.data.length).toBeLessThanOrEqual(1);
      expect(corpo.meta).toBeTruthy();
      expect(corpo.meta.page).toBe(1);
      expect(corpo.meta.limit).toBe(1);
      expect(corpo.facets).toBeTruthy();
    });

    it("COM apenas busca (sem page/limit explícitos): continua no contrato paginado/facetado, nunca no legado", async () => {
      const nome = `SoBusca ${Date.now()}`;
      await fetch(`${baseUrl}/api/v1/fornecedores`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico() }),
      });
      const resposta = await fetch(`${baseUrl}/api/v1/fornecedores?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: { nome: string }[]; meta: { total: number } };
      expect(corpo.meta).toBeTruthy(); // presença de QUALQUER param já ativa o contrato paginado
      expect(corpo.data).toHaveLength(1);
    });

    it("fornecedores soft-deleted continuam excluídos tanto no modo legado quanto no paginado", async () => {
      const nome = `SoftDel ${Date.now()}`;
      const criacao = await fetch(`${baseUrl}/api/v1/fornecedores`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico() }),
      });
      const fornecedorId = ((await criacao.json()) as { data: { id: string } }).data.id;
      await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedorId}`, { method: "DELETE", headers: authHeaders() });

      const legado = await fetch(`${baseUrl}/api/v1/fornecedores`, { headers: authHeaders() });
      const corpoLegado = (await legado.json()) as { data: { id: string }[] };
      expect(corpoLegado.data.some((fornecedor) => fornecedor.id === fornecedorId)).toBe(false);

      const paginado = await fetch(`${baseUrl}/api/v1/fornecedores?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
      const corpoPaginado = (await paginado.json()) as { data: { id: string }[] };
      expect(corpoPaginado.data.some((fornecedor) => fornecedor.id === fornecedorId)).toBe(false);
    });

    it("array completo continua trazendo os agregados públicos (produtosVinculados/valorEmCusto/ultimaEntrada) calculados normalmente", async () => {
      const nome = `Agregados ${Date.now()}`;
      const criacao = await fetch(`${baseUrl}/api/v1/fornecedores`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico() }),
      });
      const fornecedorId = ((await criacao.json()) as { data: { id: string } }).data.id;

      await fetch(`${baseUrl}/api/v1/produtos`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome: `Produto Agregado ${Date.now()}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false, fornecedorId }),
      });

      const resposta = await fetch(`${baseUrl}/api/v1/fornecedores`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: { id: string; produtosVinculados: number; valorEmCusto: number; ultimaEntrada: string | null }[] };
      const encontrado = corpo.data.find((fornecedor) => fornecedor.id === fornecedorId)!;
      expect(encontrado.produtosVinculados).toBe(1);
      expect(encontrado.valorEmCusto).toBe(0); // produto recém-criado, sem estoque ainda (0 × precoCusto)
      expect(encontrado.ultimaEntrada).not.toBeNull();
    });

    it("não quebra criação/atualização/exclusão/histórico/facetas já existentes (regressão)", async () => {
      const nome = `Regressão ${Date.now()}`;
      const telefone = telefoneUnico();

      const criacao = await fetch(`${baseUrl}/api/v1/fornecedores`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone }),
      });
      expect(criacao.status).toBe(201);
      const fornecedorId = ((await criacao.json()) as { data: { id: string } }).data.id;

      const atualizacao = await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedorId}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ nome: `${nome} Atualizado`, telefone }),
      });
      expect(atualizacao.status).toBe(200);

      const historico = await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedorId}/historico`, { headers: authHeaders() });
      expect(historico.status).toBe(200);

      const paginado = await fetch(`${baseUrl}/api/v1/fornecedores?page=1&limit=20&produtos=sem`, { headers: authHeaders() });
      expect(paginado.status).toBe(200);
      const corpoPaginado = (await paginado.json()) as { facets: Record<string, unknown> };
      expect(corpoPaginado.facets["produtos"]).toBeTruthy();

      const exclusao = await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedorId}`, { method: "DELETE", headers: authHeaders() });
      expect(exclusao.status).toBe(200);
    });
  });

  it("POST /api/v1/fornecedores com telefone duplicado retorna 409", async () => {
    const telefone = telefoneUnico();
    await fetch(`${baseUrl}/api/v1/fornecedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Duplicado Um", telefone }),
    });
    const resposta = await fetch(`${baseUrl}/api/v1/fornecedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Duplicado Dois", telefone }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(409);
    expect(corpo.code).toBe("CONFLICT");
  });

  it("DELETE bloqueia exclusão quando há produtos vinculados (400)", async () => {
    const criacao = await fetch(`${baseUrl}/api/v1/fornecedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Fornecedor Com Produto" }),
    });
    const { data: fornecedor } = (await criacao.json()) as { data: { id: string } };

    await fetch(`${baseUrl}/api/v1/produtos`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        nome: "Produto Vinculado E2E",
        categoria: "Vestidos",
        fornecedorId: fornecedor.id,
        precoCusto: 50,
        precoVenda: 100,
      }),
    });

    const exclusao = await fetch(`${baseUrl}/api/v1/fornecedores/${fornecedor.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const corpo = (await exclusao.json()) as { code: string };
    expect(exclusao.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
  });

  it("GET /api/v1/fornecedores/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/fornecedores/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: authHeaders() });
    expect(resposta.status).toBe(404);
  });

  it("GET /docs-json documenta as rotas de Fornecedores com BearerAuth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining(["/api/v1/fornecedores", "/api/v1/fornecedores/{id}", "/api/v1/fornecedores/{id}/historico"]),
    );
  });
});
