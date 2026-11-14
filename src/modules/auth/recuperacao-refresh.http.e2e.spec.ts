import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { Types, type Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { montarOpcoesCors } from "../../config/cors.config.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "./auth.service.js";

/**
 * Fase 22.8.7.2 — contrato HTTP da recuperação idempotente (servidor real, mesmo pipeline de `main.ts`, CORS real de
 * `montarOpcoesCors` com uma origem fictícia). O cabeçalho `Idempotency-Key` é opcional; malformado → 400 ANTES de
 * qualquer efeito na sessão. Valores todos fictícios.
 */
const ORIGEM = "http://tauri.localhost";
const SENHA = "senha-correta-http-recuperacao-123";

describe("HTTP — Idempotency-Key no /auth/refresh (Fase 22.8.7.2 — servidor real)", () => {
  let app: NestExpressApplication;
  let base: string;
  let connection: Connection;
  let auth: AuthService;
  let segredoRefresh: string;
  let anterior: string | undefined;
  const criados: Types.ObjectId[] = [];

  const hash = (t: string) => createHmac("sha256", segredoRefresh).update(t).digest("hex");
  const doc = (t: string) => connection.collection("refresh_tokens").findOne({ tokenHash: hash(t) });

  async function novaSessao(sufixo: string) {
    const email = `teste.http.recuperacao.${sufixo}.${Date.now()}.${randomBytes(3).toString("hex")}@mariela.dev`;
    const { usuario } = await auth.criarAdminSeed({ nome: `HTTP ${sufixo}`, email, senha: SENHA });
    criados.push(new Types.ObjectId(usuario.id));
    return (await auth.login({ usuario: email, senha: SENHA }, { ip: null, userAgent: null })).refreshToken;
  }

  async function refresh(token: string, cabecalhos: Record<string, string> = {}, corpo: Record<string, unknown> = {}) {
    const resposta = await fetch(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGEM, ...cabecalhos },
      body: JSON.stringify({ refreshToken: token, ...corpo }),
    });
    const json = (await resposta.json()) as { code?: string; errors?: { field: string; message: string }[]; data?: { refreshToken: string } };
    return { status: resposta.status, ...json, texto: JSON.stringify(json) };
  }

  beforeAll(async () => {
    anterior = process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"];
    process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"] = `segredo-http-recuperacao-${randomBytes(24).toString("base64url")}`;
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.enableCors(montarOpcoesCors([ORIGEM]));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });
    await app.init();
    await app.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    connection = app.get(getConnectionToken());
    auth = app.get(AuthService);
    segredoRefresh = app.get(ConfigService).get<string>("jwt.refreshSecret")!;
  });

  afterAll(async () => {
    await connection.collection("refresh_tokens").deleteMany({ usuarioId: { $in: criados } });
    await connection.collection("eventos_auth").deleteMany({ usuarioId: { $in: criados } });
    await connection.collection("usuarios").deleteMany({ _id: { $in: criados } });
    await app.close();
    if (anterior === undefined) delete process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"];
    else process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"] = anterior;
  });

  it("preflight CORS do /auth/refresh continua aceitando Idempotency-Key", async () => {
    const r = await fetch(`${base}/api/v1/auth/refresh`, {
      method: "OPTIONS",
      headers: { origin: ORIGEM, "access-control-request-method": "POST", "access-control-request-headers": "content-type,idempotency-key" },
    });
    expect(r.status).toBeLessThan(300);
    expect(r.headers.get("access-control-allow-origin")).toBe(ORIGEM);
    expect((r.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("idempotency-key");
  });

  it("cliente antigo (sem cabeçalho): 201, rotação normal, sem material de recuperação", async () => {
    const R1 = await novaSessao("antigo");
    const r = await refresh(R1);
    expect(r.status).toBe(201);
    expect((await doc(R1))!["chaveHash"]).toBeUndefined();
  });

  it("cabeçalho válido: 201; resposta perdida + repetição com a mesma chave (em MAIÚSCULAS) devolve o mesmo R2", async () => {
    const R1 = await novaSessao("valido");
    const K = randomUUID();
    const primeira = await refresh(R1, { "idempotency-key": K });
    expect(primeira.status).toBe(201);
    const repeticao = await refresh(R1, { "idempotency-key": K.toUpperCase() });
    expect(repeticao.status).toBe(201);
    expect(repeticao.data!.refreshToken).toBe(primeira.data!.refreshToken);
    expect(repeticao.texto).not.toContain(K);
  });

  it("cabeçalho malformado: 400 VALIDATION_ERROR antes de qualquer efeito — R1 continua ativo, valor não ecoado", async () => {
    const R1 = await novaSessao("malformado");
    const antes = await doc(R1);
    const K = randomUUID();
    for (const valor of ["", "abc", `${K}0`, `{${K}}`, `${K}, ${K}`, "x".repeat(4_000), "00000000-0000-0000-0000-000000000000"]) {
      const r = await refresh(R1, { "idempotency-key": valor });
      expect(r.status).toBe(400);
      expect(r.code).toBe("VALIDATION_ERROR");
      expect(r.errors?.map((e) => e.field)).toEqual(["Idempotency-Key"]);
      if (valor) expect(r.texto).not.toContain(valor);
    }
    expect(await doc(R1)).toEqual(antes);
  });

  it("a chave no CORPO continua proibida (contrato do corpo inalterado): 400 e R1 intacto", async () => {
    const R1 = await novaSessao("corpo");
    const r = await refresh(R1, {}, { idempotencyKey: randomUUID() });
    expect([r.status, r.code]).toEqual([400, "VALIDATION_ERROR"]);
    expect((await doc(R1))!["revogadoEm"]).toBeNull();
  });

  it("chave diferente na repetição: 401 REFRESH_TOKEN_REUSED (mesma resposta de qualquer reuso)", async () => {
    const R1 = await novaSessao("diferente");
    await refresh(R1, { "idempotency-key": randomUUID() });
    const r = await refresh(R1, { "idempotency-key": randomUUID() });
    expect([r.status, r.code]).toEqual([401, "REFRESH_TOKEN_REUSED"]);
  });

  it("logout ignora o cabeçalho e continua revogando a família", async () => {
    const R1 = await novaSessao("logout");
    const R2 = (await refresh(R1, { "idempotency-key": randomUUID() })).data!.refreshToken;
    const r = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "malformado" },
      body: JSON.stringify({ refreshToken: R1 }),
    });
    expect(r.status).toBe(200);
    expect((await doc(R2))!["revogadoEm"]).not.toBeNull();
  });
});
