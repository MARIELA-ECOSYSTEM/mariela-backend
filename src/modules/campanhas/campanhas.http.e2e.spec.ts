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
 * `colecoes.http.e2e.spec.ts`, aplicado ao CRUD de Campanhas.
 */
describe("HTTP — Campanhas (integração — servidor real)", () => {
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
    const email = `teste.http.campanhas.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Campanhas", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("campanhas").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_campanha").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["campanha", "produto", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /api/v1/campanhas SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/campanhas`);
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/campanhas com payload inválido retorna 400 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/campanhas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "" }),
    });
    const corpo = (await resposta.json()) as { statusCode: number; code: string; errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
    expect(corpo.errors.some((erro) => erro.field === "nome")).toBe(true);
  });

  // Etapa 18.11 — mass assignment: `codigo`, `produtosVinculados` e o soft
  // delete são campos internos/calculados (nunca fazem parte de
  // `CriarCampanhaDto`). O whitelist global (`forbidNonWhitelisted: true`)
  // deve rejeitar o payload inteiro (400) em vez de simplesmente ignorar os
  // campos extras — mesma prova já feita em Coleções (Etapa 18.10).
  it("POST /api/v1/campanhas com campos internos/calculados no payload é rejeitado (400) pelo whitelist global — nunca usados como autoridade", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/campanhas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        nome: "Campanha Mass Assignment",
        inicio: "2026-01-01",
        fim: "2026-03-31",
        codigo: "CAM-9999",
        produtosVinculados: 999,
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
        excluidoEm: null,
      }),
    });
    expect(resposta.status).toBe(400);
  });

  it("fluxo completo: criar → obter → listar (paginação/busca) → status → atualizar → excluir → 404", async () => {
    const nome = `Campanha E2E ${Date.now()}`;

    const criacao = await fetch(`${baseUrl}/api/v1/campanhas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome, inicio: "2026-01-01", fim: "2026-03-31" }),
    });
    expect(criacao.status).toBe(201);
    const corpoCriacao = (await criacao.json()) as { data: { id: string; codigo: string } };
    const campanhaId = corpoCriacao.data.id;
    expect(corpoCriacao.data.codigo).toMatch(/^CAM-\d{4}$/);

    const obtido = await fetch(`${baseUrl}/api/v1/campanhas/${campanhaId}`, { headers: authHeaders() });
    expect(obtido.status).toBe(200);

    const listagem = await fetch(`${baseUrl}/api/v1/campanhas?busca=${encodeURIComponent(nome)}&page=1&limit=20`, {
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

    const produtosVinculados = await fetch(`${baseUrl}/api/v1/campanhas/${campanhaId}/produtos`, { headers: authHeaders() });
    const corpoProdutos = (await produtosVinculados.json()) as { data: unknown[] };
    expect(produtosVinculados.status).toBe(200);
    expect(corpoProdutos.data).toEqual([]);

    const status = await fetch(`${baseUrl}/api/v1/campanhas/${campanhaId}/status`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ ativo: false }),
    });
    const corpoStatus = (await status.json()) as { data: { ativo: boolean } };
    expect(status.status).toBe(200);
    expect(corpoStatus.data.ativo).toBe(false);

    const atualizacao = await fetch(`${baseUrl}/api/v1/campanhas/${campanhaId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ nome: `${nome} Atualizada`, inicio: "2026-01-01", fim: "2026-03-31", ativo: true }),
    });
    const corpoAtualizacao = (await atualizacao.json()) as { data: { nome: string; ativo: boolean } };
    expect(atualizacao.status).toBe(200);
    expect(corpoAtualizacao.data.nome).toBe(`${nome} Atualizada`);
    expect(corpoAtualizacao.data.ativo).toBe(true);

    const exclusao = await fetch(`${baseUrl}/api/v1/campanhas/${campanhaId}`, { method: "DELETE", headers: authHeaders() });
    expect(exclusao.status).toBe(200);

    const apos = await fetch(`${baseUrl}/api/v1/campanhas/${campanhaId}`, { headers: authHeaders() });
    expect(apos.status).toBe(404);

    const listaApos = await fetch(`${baseUrl}/api/v1/campanhas?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
    const corpoListaApos = (await listaApos.json()) as { data: unknown[] };
    expect(corpoListaApos.data).toHaveLength(0);
  });

  it("POST /api/v1/campanhas com fim anterior ao início retorna 400", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/campanhas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Campanha Inválida", inicio: "2026-06-01", fim: "2026-01-01" }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
  });

  it("DELETE bloqueia exclusão quando há produtos vinculados (400)", async () => {
    const criacao = await fetch(`${baseUrl}/api/v1/campanhas`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Campanha Com Produto", inicio: "2026-01-01", fim: "2026-03-31" }),
    });
    const { data: campanha } = (await criacao.json()) as { data: { id: string } };

    await fetch(`${baseUrl}/api/v1/produtos`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        nome: "Produto Vinculado E2E",
        categoria: "Vestidos",
        campanhaId: campanha.id,
        precoCusto: 50,
        precoVenda: 100,
      }),
    });

    const exclusao = await fetch(`${baseUrl}/api/v1/campanhas/${campanha.id}`, { method: "DELETE", headers: authHeaders() });
    const corpo = (await exclusao.json()) as { code: string };
    expect(exclusao.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
  });

  it("GET /api/v1/campanhas/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/campanhas/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: authHeaders() });
    expect(resposta.status).toBe(404);
  });

  describe("GET /campanhas: contrato duplo retrocompatível (Etapa 16.2)", () => {
    it("SEM nenhum query param: devolve o array COMPLETO de campanhas ativas, sem meta/facets, sem truncar em 20 (contrato legado do Backoffice)", async () => {
      const prefixo = `Legado${Date.now()}`;
      await Promise.all(
        Array.from({ length: 21 }, (_, indice) =>
          fetch(`${baseUrl}/api/v1/campanhas`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ nome: `${prefixo} ${indice}`, inicio: "2026-01-01", fim: "2026-03-31" }),
          }),
        ),
      );

      const resposta = await fetch(`${baseUrl}/api/v1/campanhas`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { nome: string }[]; meta?: unknown; facets?: unknown };
      expect(Array.isArray(corpo.data)).toBe(true);
      expect(corpo.meta).toBeUndefined();
      expect(corpo.facets).toBeUndefined();
      expect(corpo.data.filter((campanha) => campanha.nome.startsWith(prefixo))).toHaveLength(21); // nunca truncado em 20 (LIMITE_PADRAO)
    });

    it("COM page/limit: preserva o contrato paginado/facetado já existente", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/campanhas?page=1&limit=1`, { headers: authHeaders() });
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
      await fetch(`${baseUrl}/api/v1/campanhas`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, inicio: "2026-01-01", fim: "2026-03-31" }),
      });
      const resposta = await fetch(`${baseUrl}/api/v1/campanhas?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: { nome: string }[]; meta: { total: number } };
      expect(corpo.meta).toBeTruthy(); // presença de QUALQUER param já ativa o contrato paginado
      expect(corpo.data).toHaveLength(1);
    });

    it("campanhas soft-deleted continuam excluídas tanto no modo legado quanto no paginado", async () => {
      const nome = `SoftDel ${Date.now()}`;
      const criacao = await fetch(`${baseUrl}/api/v1/campanhas`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, inicio: "2026-01-01", fim: "2026-03-31" }),
      });
      const campanhaId = ((await criacao.json()) as { data: { id: string } }).data.id;
      await fetch(`${baseUrl}/api/v1/campanhas/${campanhaId}`, { method: "DELETE", headers: authHeaders() });

      const legado = await fetch(`${baseUrl}/api/v1/campanhas`, { headers: authHeaders() });
      const corpoLegado = (await legado.json()) as { data: { id: string }[] };
      expect(corpoLegado.data.some((campanha) => campanha.id === campanhaId)).toBe(false);

      const paginado = await fetch(`${baseUrl}/api/v1/campanhas?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
      const corpoPaginado = (await paginado.json()) as { data: { id: string }[] };
      expect(corpoPaginado.data.some((campanha) => campanha.id === campanhaId)).toBe(false);
    });

    it("array completo continua trazendo produtosVinculados calculado normalmente", async () => {
      const nome = `Agregados ${Date.now()}`;
      const criacao = await fetch(`${baseUrl}/api/v1/campanhas`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, inicio: "2026-01-01", fim: "2026-03-31" }),
      });
      const campanhaId = ((await criacao.json()) as { data: { id: string } }).data.id;

      await fetch(`${baseUrl}/api/v1/produtos`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome: `Produto Agregado ${Date.now()}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, campanhaId }),
      });

      const resposta = await fetch(`${baseUrl}/api/v1/campanhas`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: { id: string; produtosVinculados: number }[] };
      const encontrada = corpo.data.find((campanha) => campanha.id === campanhaId)!;
      expect(encontrada.produtosVinculados).toBe(1);
    });
  });

  it("GET /docs-json documenta as rotas de Campanhas com BearerAuth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/campanhas",
        "/api/v1/campanhas/{id}",
        "/api/v1/campanhas/{id}/produtos",
        "/api/v1/campanhas/{id}/status",
      ]),
    );
  });
});
