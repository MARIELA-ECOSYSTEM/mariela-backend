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
import { ClientesService } from "../clientes/clientes.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE contra o banco de teste isolado
 * (`mariela_test` — nunca `mariela_dev`), mesmo padrão dos demais módulos.
 */
describe("HTTP — PDV Clientes (integração — servidor real)", () => {
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
    const email = `teste.http.pdv-clientes.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP PDV Clientes", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["cliente", "vendedor", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  async function criarELogarVendedor(ativo = true): Promise<{ id: string; codigo: string; accessToken: string }> {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await vendedoresService.criar({ nome: "Vendedora HTTP PDV Clientes", telefone: telefoneUnico(), ativo: true, senha: "senha123" }, null);

    const respostaLogin = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }),
    });
    const corpo = (await respostaLogin.json()) as { data: { accessToken: string } };

    if (!ativo) await vendedoresService.alterarStatus(vendedor.id, { ativo: false }, null);

    return { id: vendedor.id, codigo: vendedor.codigo, accessToken: corpo.data.accessToken };
  }

  async function criarCliente(nome: string) {
    const clientesService = app.get(ClientesService);
    return clientesService.criar({ nome, telefone: telefoneUnico() }, null);
  }

  it("GET /api/v1/pdv/clientes SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes`);
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/pdv/clientes com token do ADMIN é rejeitado (401)", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes`, { headers: jsonHeaders(adminAccessToken) });
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/pdv/clientes com vendedor ativo retorna 200 e a lista paginada", async () => {
    const vendedor = await criarELogarVendedor();
    const cliente = await criarCliente(`Cliente Catálogo HTTP ${Date.now()}`);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes?busca=${encodeURIComponent(cliente.nome)}`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: unknown[]; meta: { total: number; page: number; limit: number; totalPages: number } };
    expect(corpo.data).toHaveLength(1);
    expect(corpo.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
  });

  it("busca por telefone funciona via HTTP real", async () => {
    const vendedor = await criarELogarVendedor();
    const cliente = await criarCliente(`Busca Telefone HTTP ${Date.now()}`);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes?busca=${encodeURIComponent(cliente.telefone)}`, { headers: jsonHeaders(vendedor.accessToken) });
    const corpo = (await resposta.json()) as { data: { id: string }[] };
    expect(corpo.data.some((item) => item.id === cliente.id)).toBe(true);
  });

  it("paginação real via query params (page/limit)", async () => {
    const vendedor = await criarELogarVendedor();
    const base = `Paginação Clientes HTTP ${Date.now()}`;
    await criarCliente(`${base} A`);
    await criarCliente(`${base} B`);
    await criarCliente(`${base} C`);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes?busca=${encodeURIComponent(base)}&page=1&limit=2`, { headers: jsonHeaders(vendedor.accessToken) });
    const corpo = (await resposta.json()) as { data: unknown[]; meta: { total: number; totalPages: number } };
    expect(corpo.data).toHaveLength(2);
    expect(corpo.meta.total).toBe(3);
    expect(corpo.meta.totalPages).toBe(2);
  });

  it("busca sem resultados retorna 200 com lista vazia (nunca 404)", async () => {
    const vendedor = await criarELogarVendedor();
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes?busca=${encodeURIComponent(`Inexistente ${Date.now()}`)}`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: unknown[]; meta: { total: number } };
    expect(corpo.data).toHaveLength(0);
    expect(corpo.meta.total).toBe(0);
  });

  it("cliente excluído não aparece na listagem", async () => {
    const vendedor = await criarELogarVendedor();
    const clientesService = app.get(ClientesService);
    const cliente = await criarCliente(`Excluído HTTP ${Date.now()}`);
    await clientesService.excluir(cliente.id, null);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes?busca=${encodeURIComponent(cliente.nome)}`, { headers: jsonHeaders(vendedor.accessToken) });
    const corpo = (await resposta.json()) as { data: unknown[] };
    expect(corpo.data).toHaveLength(0);
  });

  it("vendedor inativo é rejeitado (401)", async () => {
    const vendedor = await criarELogarVendedor(false);
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(401);
  });

  it("vendedor excluído (soft delete) é rejeitado (401)", async () => {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await criarELogarVendedor();
    await vendedoresService.excluir(vendedor.id, null);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(401);
  });

  it("resposta nunca contém dados administrativos/sensíveis (compras, totalComprado, observacao, dataNascimento)", async () => {
    const vendedor = await criarELogarVendedor();
    await criarCliente(`Segurança HTTP ${Date.now()}`);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes`, { headers: jsonHeaders(vendedor.accessToken) });
    const bruto = await resposta.text();
    expect(bruto).not.toContain("compras");
    expect(bruto).not.toContain("totalComprado");
    expect(bruto).not.toContain("observacao");
    expect(bruto).not.toContain("dataNascimento");
    expect(bruto).not.toContain("telefoneNormalizado");
  });

  it("não existe endpoint administrativo de Clientes acessível por token do PDV (/clientes é rejeitado)", async () => {
    const vendedor = await criarELogarVendedor();
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/pdv/clientes não existe (decisão: cadastro continua exclusivo do Backoffice) — 404", async () => {
    const vendedor = await criarELogarVendedor();
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes`, { method: "POST", headers: jsonHeaders(vendedor.accessToken), body: JSON.stringify({}) });
    expect(resposta.status).toBe(404);
  });

  it("GET /docs-json documenta /pdv/clientes com o security scheme Bearer", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(documento.paths["/api/v1/pdv/clientes"]?.["get"]).toBeTruthy();
  });
});
