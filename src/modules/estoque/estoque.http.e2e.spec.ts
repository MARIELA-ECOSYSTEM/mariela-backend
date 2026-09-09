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
import { ProdutosService } from "../produtos/produtos.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global) — mesmo padrão de `adquirentes.http.e2e.spec.ts`.
 * Escopo enxuto de propósito (Etapa 12.2): a regra de negócio já está
 * exaustivamente coberta em `estoque.service.spec.ts`; aqui só se valida a
 * fronteira HTTP → Guard → ValidationPipe → Controller → Service.
 */
describe("HTTP — Estoque (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;

  function jsonHeaders(token?: string): Record<string, string> {
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  async function criarProdutoComTamanho(quantidadeInicial: number) {
    const produtosService = app.get(ProdutosService);
    const produto = await produtosService.criar(
      { nome: `Produto HTTP Estoque ${Date.now()}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 150, ehNovidade: false },
      null,
    );
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Preto" }, null);
    const varianteComTamanho = await produtosService.adicionarTamanho(produto.id, String(variante._id), { tamanho: "M", quantidade: quantidadeInicial }, null);
    return { produtoId: produto.id, varianteId: String(variante._id), tamanhoId: String(varianteComTamanho.tamanhos[0]!._id) };
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
    const email = `teste.http.estoque.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Estoque", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("movimentacoes_estoque").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["produto", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /estoque SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/estoque`, { headers: jsonHeaders() });
    expect(resposta.status).toBe(401);
  });

  it("POST /estoque/entrada SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/estoque/entrada`, { method: "POST", headers: jsonHeaders(), body: "{}" });
    expect(resposta.status).toBe(401);
  });

  it("GET /estoque com token ADMIN devolve um array (sem meta/facets)", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/estoque`, { headers: jsonHeaders(adminAccessToken) });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: unknown[] };
    expect(Array.isArray(corpo.data)).toBe(true);
  });

  it("POST /estoque/entrada com campo desconhecido no payload é rejeitado (400) pelo whitelist global", async () => {
    const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(5);
    const resposta = await fetch(`${baseUrl}/api/v1/estoque/entrada`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ produtoId, varianteId, tamanhoId, quantidade: 1, saldoResultante: 999 }),
    });
    expect(resposta.status).toBe(400);
  });

  it("fluxo completo via HTTP: entrada aumenta o saldo, saída reduz, saldo negativo é rejeitado", async () => {
    const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(2);

    const entrada = await fetch(`${baseUrl}/api/v1/estoque/entrada`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ produtoId, varianteId, tamanhoId, quantidade: 3 }),
    });
    expect(entrada.status).toBe(201);
    const corpoEntrada = (await entrada.json()) as { data: { quantidadeTotal: number } };
    expect(corpoEntrada.data.quantidadeTotal).toBe(5);

    const saida = await fetch(`${baseUrl}/api/v1/estoque/saida`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ produtoId, varianteId, tamanhoId, quantidade: 2, motivo: "Venda balcão" }),
    });
    expect(saida.status).toBe(201);
    const corpoSaida = (await saida.json()) as { data: { quantidadeTotal: number } };
    expect(corpoSaida.data.quantidadeTotal).toBe(3);

    const saidaExcedente = await fetch(`${baseUrl}/api/v1/estoque/saida`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ produtoId, varianteId, tamanhoId, quantidade: 100, motivo: "Além do saldo" }),
    });
    expect(saidaExcedente.status).toBe(400);
  });

  it("resposta de erro nunca vaza stack trace/detalhe interno", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/estoque/entrada`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ produtoId: "65f1a2b3c4d5e6f7a8b9c0d1", varianteId: "65f1a2b3c4d5e6f7a8b9c0d1", tamanho: "M", quantidade: 1 }),
    });
    expect(resposta.status).toBe(404);
    const corpo = (await resposta.json()) as Record<string, unknown>;
    expect(JSON.stringify(corpo)).not.toContain("at ");
    expect(JSON.stringify(corpo)).not.toMatch(/\.ts:\d+/);
  });
});
