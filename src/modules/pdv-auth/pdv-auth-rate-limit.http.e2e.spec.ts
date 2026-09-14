import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Connection } from "mongoose";
import type { AddressInfo } from "node:net";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { PDV_AUTH_LOGIN_THROTTLE_LIMITE } from "./pdv-auth.constants.js";
import { PdvAuthService } from "./pdv-auth.service.js";

/**
 * Etapa 24 — rate limiting de `POST /pdv/auth/login`. Mesmo racional de
 * `auth-rate-limit.http.e2e.spec.ts` (app próprio, isolado; cenário de reset
 * de janela coberto genericamente em `app-throttler.guard.http.e2e.spec.ts`,
 * não repetido aqui).
 *
 * Cada tentativa de senha errada usa um VENDEDOR NOVO (código sequencial
 * distinto) de propósito: `PdvAuthLoginThrottleService` já existente conta
 * falhas por `IP+código` (5 falhas/15min) — reusar o mesmo vendedor
 * acabaria disparando aquele mecanismo antes do novo throttle por IP desta
 * etapa, misturando as duas camadas no mesmo teste.
 */
describe("HTTP — PDV Auth: rate limiting de POST /pdv/auth/login (Etapa 24)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let contadorTelefone = 0;

  function jsonHeaders(): Record<string, string> {
    return { "content-type": "application/json" };
  }

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1199${String(contadorTelefone).padStart(6, "0")}`;
  }

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });

    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });

    await app.init();
    await app.listen(0);
    const endereco = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${endereco.port}`;
    connection = app.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: "vendedor" });
    await app.close();
  });

  async function tentarLoginComSenhaErrada(): Promise<Response> {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await vendedoresService.criar(
      { nome: "Vendedora Rate Limit", telefone: telefoneUnico(), ativo: true, senha: "senha123" },
      null,
    );
    return fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha-errada" }),
    });
  }

  it("requisições abaixo do limite funcionam normalmente (chegam ao handler, recebem 401 por senha errada)", async () => {
    for (let indice = 0; indice < 3; indice += 1) {
      const resposta = await tentarLoginComSenhaErrada();
      expect(resposta.status).toBe(401);
    }
  });

  it("requisições consecutivas continuam funcionando enquanto abaixo do limite", async () => {
    for (let indice = 0; indice < 3; indice += 1) {
      const resposta = await tentarLoginComSenhaErrada();
      expect(resposta.status).toBe(401);
      const corpo = (await resposta.json()) as { statusCode: number; code: string };
      expect(corpo.statusCode).toBe(401);
      expect(corpo.code).toBe("INVALID_CREDENTIALS");
    }
  });

  it(`a requisição que ultrapassa o limite (${PDV_AUTH_LOGIN_THROTTLE_LIMITE} por janela) retorna 429`, async () => {
    // Cumulativo: 3 + 3 já enviadas acima = 6.
    const faltamParaOLimite = PDV_AUTH_LOGIN_THROTTLE_LIMITE - 6;
    for (let indice = 0; indice < faltamParaOLimite; indice += 1) {
      const resposta = await tentarLoginComSenhaErrada();
      expect(resposta.status).toBe(401);
    }

    const bloqueada = await tentarLoginComSenhaErrada();
    expect(bloqueada.status).toBe(429);
    const corpo = (await bloqueada.json()) as { statusCode: number; code: string; message: string };
    expect(corpo.statusCode).toBe(429);
    expect(corpo.code).toBe("TOO_MANY_REQUESTS");
  });

  it("regressão: com o balde de /pdv/auth/login esgotado, outra rota (JWT do PDV) continua funcionando normalmente", async () => {
    const vendedoresService = app.get(VendedoresService);
    const pdvAuthService = app.get(PdvAuthService);
    const vendedor = await vendedoresService.criar(
      { nome: "Vendedora Regressao", telefone: telefoneUnico(), ativo: true, senha: "senha123" },
      null,
    );
    // Login via service direto (não passa pela rota throttled) — só para
    // obter um token válido e provar que /pdv/auth/me (rota DIFERENTE, seu
    // próprio balde) segue funcionando mesmo com /pdv/auth/login esgotada.
    const login = await pdvAuthService.login({ codigo: vendedor.codigo, senha: "senha123" }, { ip: null, userAgent: null });

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/me`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: { codigo: string } };
    expect(corpo.data.codigo).toBe(vendedor.codigo);
  });
});
