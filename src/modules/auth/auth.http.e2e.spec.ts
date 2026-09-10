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
import { AuthService } from "./auth.service.js";

/**
 * Diferente de `auth.service.spec.ts` (chama o service diretamente), este
 * teste sobe a aplicação HTTP DE VERDADE — mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global — usando `fetch()` nativo (Bun/Node 18+),
 * sem adicionar `supertest` como dependência.
 */
describe("HTTP — autenticação e proteção de rotas (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });

    // Mesmo pipeline de `main.ts` — o teste teria valor limitado se não
    // exercitasse a configuração real de validação/erro/envelope.
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
    const email = `teste.http.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: "usuario" });
    await app.close();
  });

  it("GET /health responde 200 sem token", async () => {
    const resposta = await fetch(`${baseUrl}/health`);
    expect(resposta.status).toBe(200);
  });

  it("GET /api/v1/produtos SEM token retorna 401 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/produtos`);
    const corpo = (await resposta.json()) as { statusCode: number; code: string };
    expect(resposta.status).toBe(401);
    expect(corpo.code).toBeTruthy();
  });

  it("GET /api/v1/estoque SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/estoque`);
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/produtos COM token válido retorna 200", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/produtos`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(resposta.status).toBe(200);
  });

  it("GET /api/v1/estoque COM token válido retorna 200", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/estoque`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(resposta.status).toBe(200);
  });

  it("Etapa 18.20 — GET /api/v1/produtos com token ADULTERADO (assinatura inválida) retorna 401", async () => {
    // Altera o último caractere da assinatura (3ª parte do JWT) — payload
    // continua decodificável, mas a assinatura não bate mais com o segredo.
    const partes = accessToken.split(".");
    const assinaturaAdulterada = partes[2]!.slice(0, -1) + (partes[2]!.endsWith("A") ? "B" : "A");
    const tokenAdulterado = `${partes[0]}.${partes[1]}.${assinaturaAdulterada}`;

    const resposta = await fetch(`${baseUrl}/api/v1/produtos`, {
      headers: { authorization: `Bearer ${tokenAdulterado}` },
    });
    expect(resposta.status).toBe(401);
  });

  it("Etapa 18.20 — GET /api/v1/produtos com token malformado (não é um JWT) retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/produtos`, {
      headers: { authorization: "Bearer isto-nao-e-um-jwt-valido" },
    });
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/auth/login com credenciais corretas devolve tokens no envelope padrão", async () => {
    const email = `teste.http.login.${Date.now()}@mariela.dev`;
    const authService = app.get(AuthService);
    await authService.criarAdminSeed({ nome: "Login HTTP", email, senha: "senha-forte-123" });

    const resposta = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usuario: email, senha: "senha-forte-123" }),
    });
    const corpo = (await resposta.json()) as { data: { accessToken: string; refreshToken: string; usuario: unknown } };

    expect(resposta.status).toBe(201); // POST sem @HttpCode = 201 (padrão do Nest)
    expect(corpo.data.accessToken).toBeTruthy();
    expect(corpo.data.refreshToken).toBeTruthy();
    expect(JSON.stringify(corpo.data)).not.toContain("senhaHash");
  });

  it("POST /api/v1/auth/login com senha errada retorna 401 sem revelar a causa", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usuario: "ninguem@mariela.dev", senha: "errada" }),
    });
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/auth/me com o token emitido no login devolve o usuário sem senha", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const corpo = (await resposta.json()) as { data: Record<string, unknown> };
    expect(resposta.status).toBe(200);
    expect(corpo.data["senhaHash"]).toBeUndefined();
  });

  it("GET /docs (Swagger) continua acessível", async () => {
    const resposta = await fetch(`${baseUrl}/docs`);
    expect(resposta.status).toBe(200);
  });

  it("GET /docs-json documenta as rotas de auth e exige BearerAuth em Produtos", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as {
      paths: Record<string, unknown>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/auth/login",
        "/api/v1/auth/refresh",
        "/api/v1/auth/logout",
        "/api/v1/auth/me",
      ]),
    );
    expect(documento.components?.securitySchemes).toBeTruthy();
  });
});
