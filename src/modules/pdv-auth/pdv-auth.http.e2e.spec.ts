import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { AddressInfo } from "node:net";
import { Types, type Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "../auth/auth.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import type { PdvJwtPayload, ResultadoAutenticacaoPdv, VendedorPublicoPdv } from "./pdv-auth.types.js";

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de exceções,
 * mesmo prefixo global) contra o banco de teste isolado (`mariela_test` —
 * nunca `mariela_dev`), mesmo padrão de `vendas.http.e2e.spec.ts`.
 *
 * Cobre o fluxo completo do MARIELA PDV pedido na especificação: criar
 * vendedor → login → /me → refresh → reuso do token antigo (401) → logout →
 * uso da sessão revogada (401) — além da separação real entre o JWT do
 * Backoffice (ADMIN) e o do PDV (Vendedor) nos dois sentidos.
 */
describe("HTTP — PDV Auth (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1195${String(contadorTelefone).padStart(6, "0")}`;
  }

  function jsonHeaders(): Record<string, string> {
    return { "content-type": "application/json" };
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
    const email = `teste.http.pdv-auth.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP PDV Auth", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
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

  async function criarVendedorSeed(ativo = true) {
    const vendedoresService = app.get(VendedoresService);
    return vendedoresService.criar(
      { nome: "Vendedora HTTP PDV", telefone: telefoneUnico(), ativo, senha: "senha123" },
      null,
    );
  }

  /**
   * Assina um access token do PDV com o MESMO segredo (`PDV_JWT_ACCESS_SECRET`)
   * configurado no `PdvAuthModule` real — uma instância standalone de
   * `JwtService` (fora do container de DI) produz um token byte-a-byte
   * equivalente ao que `PdvAuthService.emitirTokens` geraria, sem a
   * complexidade de extrair o `JwtService` escopado do módulo via `app.select`.
   */
  async function assinarTokenPdv(payload: PdvJwtPayload, expiresIn?: string | number): Promise<string> {
    const jwtServicePdv = new JwtService({ secret: process.env["PDV_JWT_ACCESS_SECRET"]! });
    return jwtServicePdv.signAsync(payload, expiresIn !== undefined ? { expiresIn } : undefined);
  }

  it("GET /api/v1/pdv/auth/me SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/me`);
    expect(resposta.status).toBe(401);
  });

  it("fluxo completo: criar vendedor → login → /me → refresh → reuso do token antigo (401) → logout → sessão revogada (401)", async () => {
    const vendedor = await criarVendedorSeed();

    // login
    const respostaLogin = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }),
    });
    expect(respostaLogin.status).toBe(201);
    const corpoLogin = (await respostaLogin.json()) as { data: ResultadoAutenticacaoPdv };
    const { accessToken, refreshToken } = corpoLogin.data;
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
    expect(JSON.stringify(corpoLogin)).not.toContain("senhaHash");

    // /me
    const respostaMe = await fetch(`${baseUrl}/api/v1/pdv/auth/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(respostaMe.status).toBe(200);
    const corpoMe = (await respostaMe.json()) as { data: VendedorPublicoPdv };
    expect(corpoMe.data.id).toBe(vendedor.id);
    expect(corpoMe.data.codigo).toBe(vendedor.codigo);

    // refresh
    const respostaRefresh = await fetch(`${baseUrl}/api/v1/pdv/auth/refresh`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ refreshToken }),
    });
    expect(respostaRefresh.status).toBe(201);
    const corpoRefresh = (await respostaRefresh.json()) as { data: ResultadoAutenticacaoPdv };
    const novaSessao = corpoRefresh.data;
    expect(novaSessao.refreshToken).not.toBe(refreshToken);

    // reuso do refresh token antigo → 401
    const respostaReuso = await fetch(`${baseUrl}/api/v1/pdv/auth/refresh`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ refreshToken }),
    });
    expect(respostaReuso.status).toBe(401);

    // logout da sessão nova
    const respostaLogout = await fetch(`${baseUrl}/api/v1/pdv/auth/logout`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ refreshToken: novaSessao.refreshToken }),
    });
    expect(respostaLogout.status).toBe(200);

    // usar a sessão revogada para renovar → 401
    const respostaPosLogout = await fetch(`${baseUrl}/api/v1/pdv/auth/refresh`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ refreshToken: novaSessao.refreshToken }),
    });
    expect(respostaPosLogout.status).toBe(401);
  });

  it("login com código inexistente retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: "VEN-9999", senha: "qualquer" }),
    });
    expect(resposta.status).toBe(401);
  });

  it("login com senha incorreta retorna 401", async () => {
    const vendedor = await criarVendedorSeed();
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha-errada" }),
    });
    expect(resposta.status).toBe(401);
  });

  it("login com payload inválido (sem senha) retorna 400", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: "VEN-0001" }),
    });
    expect(resposta.status).toBe(400);
  });

  it("vendedor inativo não consegue logar", async () => {
    const vendedor = await criarVendedorSeed(false);
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }),
    });
    expect(resposta.status).toBe(401);
  });

  describe("guard: PdvJwtAuthGuard", () => {
    it("token malformado/inválido retorna 401", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/me`, { headers: { authorization: "Bearer token-invalido" } });
      expect(resposta.status).toBe(401);
    });

    it("token expirado retorna 401", async () => {
      const vendedor = await criarVendedorSeed();
      const tokenExpirado = await assinarTokenPdv(
        { sub: vendedor.id, vendedorId: vendedor.id, codigo: vendedor.codigo, tipo: "PDV" },
        -10,
      );
      const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/me`, { headers: { authorization: `Bearer ${tokenExpirado}` } });
      expect(resposta.status).toBe(401);
    });

    it("vendedor referenciado no token não existe mais retorna 401", async () => {
      const idInexistente = new Types.ObjectId().toString();
      const token = await assinarTokenPdv({ sub: idInexistente, vendedorId: idInexistente, codigo: "VEN-0000", tipo: "PDV" });
      const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(resposta.status).toBe(401);
    });

    it("vendedor desativado DEPOIS de emitido o token perde acesso na próxima requisição", async () => {
      const vendedoresService = app.get(VendedoresService);
      const vendedor = await criarVendedorSeed();
      const token = await assinarTokenPdv({ sub: vendedor.id, vendedorId: vendedor.id, codigo: vendedor.codigo, tipo: "PDV" });

      const antes = await fetch(`${baseUrl}/api/v1/pdv/auth/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(antes.status).toBe(200);

      await vendedoresService.alterarStatus(vendedor.id, { ativo: false }, null);

      const depois = await fetch(`${baseUrl}/api/v1/pdv/auth/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(depois.status).toBe(401);
    });

    it("vendedor excluído (soft delete) DEPOIS de emitido o token perde acesso", async () => {
      const vendedoresService = app.get(VendedoresService);
      const vendedor = await criarVendedorSeed();
      const token = await assinarTokenPdv({ sub: vendedor.id, vendedorId: vendedor.id, codigo: vendedor.codigo, tipo: "PDV" });

      await vendedoresService.excluir(vendedor.id, null);

      const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(resposta.status).toBe(401);
    });
  });

  describe("separação real entre ADMIN e PDV", () => {
    it("um JWT do ADMIN não autentica /pdv/auth/me", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/me`, { headers: { authorization: `Bearer ${adminAccessToken}` } });
      expect(resposta.status).toBe(401);
    });

    it("um JWT do PDV não autentica uma rota administrativa do Backoffice", async () => {
      const vendedor = await criarVendedorSeed();
      const tokenPdv = await assinarTokenPdv({ sub: vendedor.id, vendedorId: vendedor.id, codigo: vendedor.codigo, tipo: "PDV" });

      const resposta = await fetch(`${baseUrl}/api/v1/vendedores`, { headers: { authorization: `Bearer ${tokenPdv}` } });
      expect(resposta.status).toBe(401);
    });
  });

  it("não existe POST /api/v1/vendas no namespace administrativo (a criação é exclusiva do PDV)", async () => {
    // `POST /api/v1/pdv/vendas` passou a existir a partir da Etapa 05 do PDV
    // (protegido por PdvJwtAuthGuard, ver `pdv-vendas.http.e2e.spec.ts`) — o
    // invariante que nunca muda é este: o Backoffice/ADMIN jamais ganha uma
    // rota de criação de venda.
    const respostaAdmin = await fetch(`${baseUrl}/api/v1/vendas`, { method: "POST", headers: jsonHeaders(), body: "{}" });
    expect(respostaAdmin.status).toBe(404);
  });

  it("GET /docs-json documenta as 4 rotas de /pdv/auth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(documento.paths["/api/v1/pdv/auth/login"]?.["post"]).toBeTruthy();
    expect(documento.paths["/api/v1/pdv/auth/refresh"]?.["post"]).toBeTruthy();
    expect(documento.paths["/api/v1/pdv/auth/logout"]?.["post"]).toBeTruthy();
    expect(documento.paths["/api/v1/pdv/auth/me"]?.["get"]).toBeTruthy();
  });
});
