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
import { AUTH_LOGIN_THROTTLE_LIMITE } from "./auth.constants.js";
import { AuthService } from "./auth.service.js";

/**
 * Etapa 24 — rate limiting de `POST /auth/login`. App próprio (nunca
 * compartilhado com `auth.http.e2e.spec.ts`): cada arquivo de teste sobe sua
 * própria instância do `AppModule`, com seu próprio armazenamento de
 * throttle em memória — as chamadas desta suíte nunca afetam nem são
 * afetadas pelas de outro arquivo.
 *
 * As contagens abaixo são cumulativas de propósito (todos os `it()` deste
 * describe compartilham o MESMO balde de throttle — mesma rota, mesmo IP
 * 127.0.0.1): projetadas para nunca ultrapassar `AUTH_LOGIN_THROTTLE_LIMITE`
 * até o ponto em que o excesso é intencional. Ver o cenário de reset de
 * janela genérico em `app-throttler.guard.http.e2e.spec.ts` — não repetido
 * aqui (janela de produção é 10s; esperar isso aqui só deixaria a suíte mais
 * lenta sem provar nada além do que o mecanismo isolado já prova).
 */
describe("HTTP — Auth: rate limiting de POST /auth/login (Etapa 24)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let email: string;

  function jsonHeaders(): Record<string, string> {
    return { "content-type": "application/json" };
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

    const authService = app.get(AuthService);
    email = `teste.http.auth-rate-limit.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "Rate Limit Auth", email, senha: "senha-forte-123" });
  });

  afterAll(async () => {
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: "usuario" });
    await app.close();
  });

  let contadorTentativa = 0;

  /**
   * Cada chamada usa um e-mail DIFERENTE (inexistente) de propósito: o
   * `LoginThrottleService` já existente (Etapa 18, `auth.constants.ts`) conta
   * falhas por `IP+e-mail` (5 falhas/15min) — usar sempre o mesmo e-mail
   * acabaria disparando ESSE mecanismo antes do novo throttle por IP desta
   * etapa, misturando as duas camadas no mesmo teste. Com e-mails distintos,
   * cada tentativa cai numa chave nova daquele mecanismo (nunca acumula 5
   * falhas para a mesma chave) — só o throttle por IP desta etapa é
   * exercitado, isoladamente.
   */
  async function tentarLoginComSenhaErrada(): Promise<Response> {
    contadorTentativa += 1;
    return fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ usuario: `naoexiste.${contadorTentativa}.${Date.now()}@mariela.dev`, senha: "senha-errada" }),
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
      // Formato de erro padrão preservado — não é o 429 nem um formato alternativo.
      expect(corpo.statusCode).toBe(401);
      expect(corpo.code).toBe("INVALID_CREDENTIALS");
    }
  });

  it(`a requisição que ultrapassa o limite (${AUTH_LOGIN_THROTTLE_LIMITE} por janela) retorna 429`, async () => {
    // Cumulativo: 3 + 3 já enviadas acima = 6. Faltam 4 para completar o
    // limite de ${AUTH_LOGIN_THROTTLE_LIMITE} (todas ainda devem funcionar,
    // 401), e a próxima (a 11ª no total) deve ser bloqueada.
    const faltamParaOLimite = AUTH_LOGIN_THROTTLE_LIMITE - 6;
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

  it("regressão: com o balde de /auth/login esgotado, outra rota (JWT/roles) continua funcionando normalmente", async () => {
    // Prova que o throttle é POR ROTA (`AuthController-login-default`), não
    // um bloqueio geral do IP: mesmo com /auth/login bloqueada acima, um
    // login via SERVICE direto (não passa pela rota throttled) + GET /auth/me
    // (rota DIFERENTE, seu próprio balde, bem abaixo do limite global de
    // 300/60s) continuam funcionando.
    const authService = app.get(AuthService);
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });

    const resposta = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: { email: string } };
    expect(corpo.data.email).toBe(email);
  });
});
