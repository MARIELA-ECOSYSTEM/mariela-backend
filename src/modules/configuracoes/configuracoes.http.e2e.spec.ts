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
import { VendedoresService } from "../vendedores/vendedores.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global) — mesmo padrão de `adquirentes.http.e2e.spec.ts`.
 */
describe("HTTP — Configurações (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1194${String(contadorTelefone).padStart(6, "0")}`;
  }

  function jsonHeaders(token?: string): Record<string, string> {
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  function enderecoValido() {
    return { cep: "01310-100", logradouro: "Av. Paulista", numero: "1000", complemento: "Sala 1", bairro: "Bela Vista", cidade: "São Paulo", estado: "SP" };
  }

  function lojaValida(extra: Record<string, unknown> = {}) {
    return {
      nome: "Loja HTTP",
      logo: "https://exemplo.com/logo.png",
      telefone: "1130000000",
      whatsapp: "11999990000",
      email: "contato@loja.com",
      endereco: enderecoValido(),
      ...extra,
    };
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
    const email = `teste.http.configuracoes.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Configurações", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("configuracoes").deleteMany({});
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

  async function criarELogarVendedorPdv(): Promise<string> {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await vendedoresService.criar({ nome: "Vendedora HTTP Configurações", telefone: telefoneUnico(), ativo: true, senha: "senha123" }, null);
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }),
    });
    const corpo = (await resposta.json()) as { data: { accessToken: string } };
    return corpo.data.accessToken;
  }

  describe("autenticação e autorização", () => {
    it("GET /configuracoes SEM token retorna 401", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes`, { headers: jsonHeaders() });
      expect(resposta.status).toBe(401);
    });

    it("um token do PDV (vendedor) é rejeitado em /configuracoes (rota administrativa)", async () => {
      const tokenVendedor = await criarELogarVendedorPdv();
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes`, { headers: jsonHeaders(tokenVendedor) });
      expect(resposta.status).toBe(401);
    });

    it("com token ADMIN válido, GET funciona normalmente", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes`, { headers: jsonHeaders(adminAccessToken) });
      expect(resposta.status).toBe(200);
    });
  });

  describe("GET /configuracoes", () => {
    it("devolve exatamente a estrutura esperada pelo Backoffice", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes`, { headers: jsonHeaders(adminAccessToken) });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: Record<string, unknown> };

      expect(Object.keys(corpo.data).sort()).toEqual(["atualizadoEm", "categorias", "cores", "formasPagamento", "loja", "tamanhos"].sort());
      expect(corpo.data["id"]).toBeUndefined(); // singleton nunca expõe id ao contrato
      expect(corpo.data["criadoEm"]).toBeUndefined();
      expect(corpo.data["__v"]).toBeUndefined();

      const loja = corpo.data["loja"] as Record<string, unknown>;
      expect(Object.keys(loja).sort()).toEqual(["email", "endereco", "logo", "nome", "telefone", "whatsapp"].sort());
      const enderecoResposta = loja["endereco"] as Record<string, unknown>;
      expect(Object.keys(enderecoResposta).sort()).toEqual(["bairro", "cep", "cidade", "complemento", "estado", "logradouro", "numero"].sort());
    });
  });

  describe("PUT /configuracoes/loja", () => {
    it("substitui os dados da loja", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes/loja`, {
        method: "PUT",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify(lojaValida()),
      });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { loja: { nome: string; endereco: { cidade: string } } } };
      expect(corpo.data.loja.nome).toBe("Loja HTTP");
      expect(corpo.data.loja.endereco.cidade).toBe("São Paulo");
    });

    it("campo desconhecido no payload é rejeitado (400) pelo whitelist global", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes/loja`, {
        method: "PUT",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify(lojaValida({ cnpj: "00.000.000/0001-00" })),
      });
      expect(resposta.status).toBe(400);
    });

    it("payload sem endereco é rejeitado (400)", async () => {
      const { endereco: _endereco, ...semEndereco } = lojaValida();
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes/loja`, {
        method: "PUT",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify(semEndereco),
      });
      expect(resposta.status).toBe(400);
    });
  });

  describe("POST/DELETE /configuracoes/:lista", () => {
    it("adiciona e remove um valor de categorias via HTTP", async () => {
      const valor = `Categoria HTTP ${Date.now()}`;
      const adicionar = await fetch(`${baseUrl}/api/v1/configuracoes/categorias`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ valor }),
      });
      expect(adicionar.status).toBe(201);
      const corpoAdicionar = (await adicionar.json()) as { data: { categorias: string[] } };
      expect(corpoAdicionar.data.categorias).toContain(valor);

      const remover = await fetch(`${baseUrl}/api/v1/configuracoes/categorias/${encodeURIComponent(valor)}`, {
        method: "DELETE",
        headers: jsonHeaders(adminAccessToken),
      });
      expect(remover.status).toBe(200);
      const corpoRemover = (await remover.json()) as { data: { categorias: string[] } };
      expect(corpoRemover.data.categorias).not.toContain(valor);
    });

    it("valor duplicado retorna 409, valor vazio retorna 400, lista inválida retorna 400", async () => {
      const valor = `Duplicidade HTTP ${Date.now()}`;
      await fetch(`${baseUrl}/api/v1/configuracoes/cores`, { method: "POST", headers: jsonHeaders(adminAccessToken), body: JSON.stringify({ valor }) });

      const duplicado = await fetch(`${baseUrl}/api/v1/configuracoes/cores`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ valor }),
      });
      expect(duplicado.status).toBe(409);

      const vazio = await fetch(`${baseUrl}/api/v1/configuracoes/cores`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ valor: "" }),
      });
      expect(vazio.status).toBe(400);

      const listaInvalida = await fetch(`${baseUrl}/api/v1/configuracoes/inexistente`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ valor: "qualquer" }),
      });
      expect(listaInvalida.status).toBe(400);
    });

    it("remover item inexistente retorna 404", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes/tamanhos/${encodeURIComponent(`Inexistente-${Date.now()}`)}`, {
        method: "DELETE",
        headers: jsonHeaders(adminAccessToken),
      });
      expect(resposta.status).toBe(404);
    });

    it("resposta de erro nunca vaza stack trace/detalhe interno", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes/lista-invalida-xyz`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ valor: "x" }),
      });
      const corpo = (await resposta.json()) as Record<string, unknown>;
      expect(JSON.stringify(corpo)).not.toContain("at ");
      expect(JSON.stringify(corpo)).not.toMatch(/\.ts:\d+/);
    });
  });
});
