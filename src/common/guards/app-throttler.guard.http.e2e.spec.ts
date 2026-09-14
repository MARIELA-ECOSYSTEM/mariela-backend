import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ThrottlerModule } from "@nestjs/throttler";
import type { AddressInfo } from "node:net";
import { HttpExceptionFilter } from "../filters/http-exception.filter.js";
import { ResponseInterceptor } from "../interceptors/response.interceptor.js";
import { AppThrottlerGuard } from "./app-throttler.guard.js";

/**
 * Etapa 24 — prova o MECANISMO de rate limiting (`AppThrottlerGuard` +
 * `ThrottlerModule`) isolado do resto da aplicação: um app Nest mínimo,
 * dedicado, com `limit`/`ttl` pequenos o bastante para testar
 * deterministicamente o ciclo completo — abaixo do limite, no limite, acima
 * do limite (429 no envelope de erro padrão do MARIELA), headers nativos
 * (`Retry-After`, `X-RateLimit-*`) e reset após a janela — sem precisar
 * subir o `AppModule` inteiro nem depender de nenhuma regra de negócio.
 *
 * `beforeEach` espera a janela inteira (`TTL_MS` + margem) antes de CADA
 * teste — cada `it()` começa de um estado limpo e independente da ordem de
 * execução, sem depender de contagem residual de um teste anterior. A
 * espera é sempre a mesma janela pequena e fixa, nunca um sleep arbitrário
 * desacoplado da configuração real do teste.
 *
 * Esta é a ÚNICA suíte que espera o fim de uma janela de verdade — as de
 * `/auth/login`, `/pdv/auth/login` e `/integracoes/whatsapp/mensagens` (que
 * usam os limites REAIS de produção, com janelas de 10s) não repetem o
 * cenário de reset: o mecanismo já é comprovado aqui, e esperar 10s+ em cada
 * uma delas só deixaria a suíte inteira mais lenta sem provar nada de novo.
 */
describe("AppThrottlerGuard (mecanismo isolado — servidor real)", () => {
  const LIMITE = 3;
  const TTL_MS = 300;
  const MARGEM_MS = 150;

  @Controller("sonda")
  class SondaController {
    @Get()
    ping() {
      return { data: { ok: true } };
    }
  }

  @Module({
    imports: [ThrottlerModule.forRoot([{ name: "default", limit: LIMITE, ttl: TTL_MS }])],
    controllers: [SondaController],
    providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
  })
  class ModuloDeTeste {}

  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(ModuloDeTeste, { logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    await app.listen(0);
    const endereco = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${endereco.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, TTL_MS + MARGEM_MS));
  });

  it(`as primeiras ${LIMITE} requisições dentro da janela funcionam normalmente`, async () => {
    for (let indice = 0; indice < LIMITE; indice += 1) {
      const resposta = await fetch(`${baseUrl}/sonda`);
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { ok: boolean } };
      expect(corpo.data.ok).toBe(true);
    }
  });

  it(`a requisição ${LIMITE + 1} (acima do limite) retorna 429 no envelope de erro padrão do MARIELA`, async () => {
    for (let indice = 0; indice < LIMITE; indice += 1) {
      const resposta = await fetch(`${baseUrl}/sonda`);
      expect(resposta.status).toBe(200);
    }

    const bloqueada = await fetch(`${baseUrl}/sonda`);
    expect(bloqueada.status).toBe(429);
    const corpo = (await bloqueada.json()) as { statusCode: number; code: string; message: string };
    expect(corpo.statusCode).toBe(429);
    expect(corpo.code).toBe("TOO_MANY_REQUESTS");
    expect(typeof corpo.message).toBe("string");
    expect(corpo.message.length).toBeGreaterThan(0);
    // Nunca o formato/mensagem padrão (em inglês) do ThrottlerException nativo.
    expect(corpo.message).not.toContain("ThrottlerException");
  });

  it("a resposta 429 inclui o header Retry-After nativo da biblioteca", async () => {
    for (let indice = 0; indice < LIMITE; indice += 1) {
      await fetch(`${baseUrl}/sonda`);
    }
    const bloqueada = await fetch(`${baseUrl}/sonda`);
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.headers.get("retry-after")).toBeTruthy();
  });

  it("uma resposta bem-sucedida inclui os headers nativos X-RateLimit-*", async () => {
    const resposta = await fetch(`${baseUrl}/sonda`);
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("x-ratelimit-limit")).toBe(String(LIMITE));
    expect(resposta.headers.get("x-ratelimit-remaining")).toBeTruthy();
  });

  it("após o fim da janela, a rota volta a aceitar requisições normalmente (reset determinístico)", async () => {
    for (let indice = 0; indice < LIMITE; indice += 1) {
      await fetch(`${baseUrl}/sonda`);
    }
    const bloqueada = await fetch(`${baseUrl}/sonda`);
    expect(bloqueada.status).toBe(429);

    // Espera EXATAMENTE a janela configurada (+ margem fixa) — determinístico,
    // não um sleep arbitrário desacoplado da configuração real do teste.
    await new Promise((resolve) => setTimeout(resolve, TTL_MS + MARGEM_MS));

    const depoisDoReset = await fetch(`${baseUrl}/sonda`);
    expect(depoisDoReset.status).toBe(200);
  });
});
