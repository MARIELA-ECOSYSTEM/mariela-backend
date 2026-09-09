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
 * exceções, mesmo prefixo global) — mesmo padrão de `adquirentes.http.e2e.spec.ts`.
 *
 * Escopo (Etapa 12.2): validar a FRONTEIRA HTTP → Guard → ValidationPipe →
 * Controller → Service → MongoDB → serialização. A regra de negócio em si
 * (cálculo de margem, normalização de cor/tamanho, derivação de
 * quantidade…) já está exaustivamente coberta em `produtos.service.spec.ts`
 * — não duplicada aqui.
 */
describe("HTTP — Produtos (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;

  function jsonHeaders(token?: string): Record<string, string> {
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  function payloadProduto(extra: Record<string, unknown> = {}) {
    return {
      nome: `Produto HTTP ${Date.now()}-${Math.random()}`,
      categoria: "Vestidos",
      precoCusto: 50,
      precoVenda: 100,
      ehNovidade: false,
      ...extra,
    };
  }

  async function criarProdutoViaHttp(extra: Record<string, unknown> = {}) {
    const resposta = await fetch(`${baseUrl}/api/v1/produtos`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify(payloadProduto(extra)),
    });
    const corpo = (await resposta.json()) as { data: { id: string; codProduto: string } };
    return corpo.data;
  }

  async function adicionarVarianteViaHttp(produtoId: string, extra: Record<string, unknown> = {}) {
    const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produtoId}/variantes`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ cor: "Preto", ...extra }),
    });
    const corpo = (await resposta.json()) as { data: { id: string } };
    return corpo.data;
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
    const email = `teste.http.produtos.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Produtos", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["produto", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  describe("autenticação", () => {
    it("GET /produtos SEM token retorna 401", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/produtos`, { headers: jsonHeaders() });
      expect(resposta.status).toBe(401);
    });

    it("POST /produtos SEM token retorna 401", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/produtos`, { method: "POST", headers: jsonHeaders(), body: "{}" });
      expect(resposta.status).toBe(401);
    });
  });

  describe("POST /produtos", () => {
    it("cria o produto e devolve a resposta serializada, com código gerado pelo backend", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/produtos`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify(payloadProduto({ nome: "Vestido Serialização" })),
      });
      expect(resposta.status).toBe(201);
      const corpo = (await resposta.json()) as { data: Record<string, unknown> };
      expect(corpo.data["codProduto"]).toMatch(/^PROD-\d{4}$/);
      expect(corpo.data["margemLucro"]).toBe(50);
      expect(corpo.data["quantidadeTotal"]).toBe(0);
      expect(corpo.data["variantes"]).toEqual([]);
      expect(corpo.data["id"]).toBeTruthy();
      // Nunca vaza campos internos.
      expect(corpo.data["excluidoEm"]).toBeUndefined();
      expect(corpo.data["_id"]).toBeUndefined();
      expect(corpo.data["__v"]).toBeUndefined();
    });

    it("DTO inválido (sem nome) retorna 400", async () => {
      const { nome: _nome, ...semNome } = payloadProduto();
      const resposta = await fetch(`${baseUrl}/api/v1/produtos`, { method: "POST", headers: jsonHeaders(adminAccessToken), body: JSON.stringify(semNome) });
      expect(resposta.status).toBe(400);
    });

    it("campos calculados/protegidos no payload são rejeitados (400) pelo whitelist global — nunca usados como autoridade", async () => {
      for (const campoExtra of [
        { codProduto: "PROD-9999" },
        { margemLucro: 999 },
        { quantidadeTotal: 100 },
        { ehPromocao: true },
        { precoPromocional: 1 },
      ]) {
        const resposta = await fetch(`${baseUrl}/api/v1/produtos`, {
          method: "POST",
          headers: jsonHeaders(adminAccessToken),
          body: JSON.stringify(payloadProduto(campoExtra)),
        });
        expect(resposta.status).toBe(400);
      }
    });
  });

  describe("GET /produtos e /produtos/:id", () => {
    it("lista produtos com meta/facets e encontra pela busca", async () => {
      const nomeUnico = `Busca Única ${Date.now()}`;
      await criarProdutoViaHttp({ nome: nomeUnico });

      const resposta = await fetch(`${baseUrl}/api/v1/produtos?busca=${encodeURIComponent(nomeUnico)}`, { headers: jsonHeaders(adminAccessToken) });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { nome: string }[]; meta: { total: number }; facets: Record<string, unknown> };
      expect(corpo.data).toHaveLength(1);
      expect(corpo.data[0]?.nome).toBe(nomeUnico);
      expect(corpo.meta.total).toBe(1);
      expect(corpo.facets["categorias"]).toBeTruthy();
    });

    it("GET /produtos/:id inexistente retorna 404", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: jsonHeaders(adminAccessToken) });
      expect(resposta.status).toBe(404);
    });
  });

  describe("PUT /produtos/:id", () => {
    it("atualiza os dados cadastrais e recalcula a margem", async () => {
      const produto = await criarProdutoViaHttp({ precoCusto: 50, precoVenda: 100 });
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}`, {
        method: "PUT",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify(payloadProduto({ precoCusto: 60, precoVenda: 120 })),
      });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { precoVenda: number; margemLucro: number } };
      expect(corpo.data.precoVenda).toBe(120);
      expect(corpo.data.margemLucro).toBe(50);
    });

    it("reduzir o preço de venda abaixo da promoção ativa retorna 400 (nunca desativa a promoção silenciosamente)", async () => {
      const produto = await criarProdutoViaHttp({ precoCusto: 50, precoVenda: 100 });
      await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/promocao`, {
        method: "PATCH",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ ehPromocao: true, precoPromocional: 80 }),
      });

      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}`, {
        method: "PUT",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify(payloadProduto({ precoCusto: 50, precoVenda: 70 })),
      });
      expect(resposta.status).toBe(400);
    });

    it("PUT em produto inexistente retorna 404", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/65f1a2b3c4d5e6f7a8b9c0d1`, {
        method: "PUT",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify(payloadProduto()),
      });
      expect(resposta.status).toBe(404);
    });
  });

  describe("DELETE /produtos/:id", () => {
    it("exclui (soft delete): some da API, mas o documento continua no banco", async () => {
      const produto = await criarProdutoViaHttp();
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}`, { method: "DELETE", headers: jsonHeaders(adminAccessToken) });
      expect(resposta.status).toBe(200);

      const detalhe = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}`, { headers: jsonHeaders(adminAccessToken) });
      expect(detalhe.status).toBe(404);

      const bruto = await connection.collection("produtos").findOne({ codProduto: produto.codProduto });
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });
  });

  describe("PATCH /produtos/:id/novidade", () => {
    it("marca e desmarca novidade", async () => {
      const produto = await criarProdutoViaHttp();
      const marca = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/novidade`, {
        method: "PATCH",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ ehNovidade: true }),
      });
      expect(marca.status).toBe(200);
      expect(((await marca.json()) as { data: { ehNovidade: boolean } }).data.ehNovidade).toBe(true);

      const desmarca = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/novidade`, {
        method: "PATCH",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ ehNovidade: false }),
      });
      expect(((await desmarca.json()) as { data: { ehNovidade: boolean } }).data.ehNovidade).toBe(false);
    });
  });

  describe("PATCH /produtos/:id/promocao", () => {
    it("ativa a promoção com preço válido", async () => {
      const produto = await criarProdutoViaHttp({ precoCusto: 50, precoVenda: 100 });
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/promocao`, {
        method: "PATCH",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ ehPromocao: true, precoPromocional: 80 }),
      });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { ehPromocao: boolean; precoPromocional: number; margemLucro: number } };
      expect(corpo.data.ehPromocao).toBe(true);
      expect(corpo.data.precoPromocional).toBe(80);
      expect(corpo.data.margemLucro).toBe(37.5);
    });

    it("preço promocional maior ou igual ao preço de venda retorna 400", async () => {
      const produto = await criarProdutoViaHttp({ precoCusto: 50, precoVenda: 100 });
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/promocao`, {
        method: "PATCH",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ ehPromocao: true, precoPromocional: 100 }),
      });
      expect(resposta.status).toBe(400);
    });
  });

  describe("variantes", () => {
    it("cria uma variante com código derivado do produto + cor", async () => {
      const produto = await criarProdutoViaHttp();
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ cor: "Azul Marinho" }),
      });
      expect(resposta.status).toBe(201);
      const corpo = (await resposta.json()) as { data: { codVariante: string; id: string } };
      expect(corpo.data.codVariante).toBe(`${produto.codProduto}-AZUL-MARINHO`);
      expect(corpo.data["corNormalizada" as keyof typeof corpo.data]).toBeUndefined();
    });

    it("cor duplicada no mesmo produto retorna 400 (nunca 409 — comportamento já existente do domínio)", async () => {
      const produto = await criarProdutoViaHttp();
      await adicionarVarianteViaHttp(produto.id, { cor: "Vermelho" });
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ cor: "vermelho" }),
      });
      expect(resposta.status).toBe(400);
    });

    it("codVariante no payload é rejeitado (400) pelo whitelist — sempre derivado pelo backend", async () => {
      const produto = await criarProdutoViaHttp();
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ cor: "Verde", codVariante: "FORJADO-123" }),
      });
      expect(resposta.status).toBe(400);
    });

    it("atualiza cor/foto/vídeo de uma variante, mantendo o codVariante original", async () => {
      const produto = await criarProdutoViaHttp();
      const variante = await adicionarVarianteViaHttp(produto.id, { cor: "Rosa" });
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}`, {
        method: "PUT",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ cor: "Rosa Claro", foto: "https://cdn.mariela.com/rosa-claro.jpg" }),
      });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { cor: string; codVariante: string; foto: string } };
      expect(corpo.data.cor).toBe("Rosa Claro");
      expect(corpo.data.codVariante).toBe(`${produto.codProduto}-ROSA`); // imutável, gerado na criação
      expect(corpo.data.foto).toBe("https://cdn.mariela.com/rosa-claro.jpg");
    });

    it("PUT em variante inexistente retorna 404", async () => {
      const produto = await criarProdutoViaHttp();
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/65f1a2b3c4d5e6f7a8b9c0d1`, {
        method: "PUT",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ cor: "Cinza" }),
      });
      expect(resposta.status).toBe(404);
    });

    it("remove uma variante e recalcula quantidadeTotal", async () => {
      const produto = await criarProdutoViaHttp();
      const variante = await adicionarVarianteViaHttp(produto.id, { cor: "Bege" });
      await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}/tamanhos`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ tamanho: "M", quantidade: 5 }),
      });

      const remocao = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}`, { method: "DELETE", headers: jsonHeaders(adminAccessToken) });
      expect(remocao.status).toBe(200);

      const detalhe = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}`, { headers: jsonHeaders(adminAccessToken) });
      const corpo = (await detalhe.json()) as { data: { quantidadeTotal: number; variantes: unknown[] } };
      expect(corpo.data.variantes).toHaveLength(0);
      expect(corpo.data.quantidadeTotal).toBe(0);
    });
  });

  describe("tamanhos", () => {
    it("adiciona um tamanho com quantidade inicial e reflete nos derivados", async () => {
      const produto = await criarProdutoViaHttp();
      const variante = await adicionarVarianteViaHttp(produto.id, { cor: "Branco" });
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}/tamanhos`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ tamanho: " p ", quantidade: 4 }),
      });
      expect(resposta.status).toBe(201);
      const corpo = (await resposta.json()) as { data: { quantidadeVariante: number; tamanhos: { tamanho: string; quantidade: number }[] } };
      expect(corpo.data.tamanhos[0]?.tamanho).toBe("P"); // normalizado
      expect(corpo.data.quantidadeVariante).toBe(4);
    });

    it("tamanho duplicado na mesma variante retorna 400", async () => {
      const produto = await criarProdutoViaHttp();
      const variante = await adicionarVarianteViaHttp(produto.id, { cor: "Cinza Chumbo" });
      await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}/tamanhos`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ tamanho: "G", quantidade: 1 }),
      });
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}/tamanhos`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ tamanho: "g", quantidade: 1 }),
      });
      expect(resposta.status).toBe(400);
    });

    it("quantidadeVariante/quantidadeTotal no payload de tamanho são rejeitados (400) pelo whitelist", async () => {
      const produto = await criarProdutoViaHttp();
      const variante = await adicionarVarianteViaHttp(produto.id, { cor: "Marrom" });
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}/tamanhos`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ tamanho: "M", quantidade: 1, quantidadeVariante: 999 }),
      });
      expect(resposta.status).toBe(400);
    });

    it("remove um tamanho e recalcula os derivados", async () => {
      const produto = await criarProdutoViaHttp();
      const variante = await adicionarVarianteViaHttp(produto.id, { cor: "Roxo" });
      const criado = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}/tamanhos`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ tamanho: "M", quantidade: 6 }),
      });
      const tamanho = ((await criado.json()) as { data: { tamanhos: { id: string }[] } }).data.tamanhos[0]!;

      const remocao = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}/tamanhos/${tamanho.id}`, {
        method: "DELETE",
        headers: jsonHeaders(adminAccessToken),
      });
      expect(remocao.status).toBe(200);

      const detalhe = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}`, { headers: jsonHeaders(adminAccessToken) });
      const corpo = (await detalhe.json()) as { data: { quantidadeTotal: number } };
      expect(corpo.data.quantidadeTotal).toBe(0);
    });

    it("remover tamanho inexistente retorna 404", async () => {
      const produto = await criarProdutoViaHttp();
      const variante = await adicionarVarianteViaHttp(produto.id, { cor: "Dourado" });
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/variantes/${variante.id}/tamanhos/65f1a2b3c4d5e6f7a8b9c0d1`, {
        method: "DELETE",
        headers: jsonHeaders(adminAccessToken),
      });
      expect(resposta.status).toBe(404);
    });
  });

  describe("PATCH /produtos/:id/foto-principal", () => {
    it("define a variante principal quando ela tem foto", async () => {
      const produto = await criarProdutoViaHttp();
      const variante = await adicionarVarianteViaHttp(produto.id, { cor: "Prata", foto: "https://cdn.mariela.com/prata.jpg" });

      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/foto-principal`, {
        method: "PATCH",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ varianteId: variante.id }),
      });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { fotoPrincipalVarianteId: string } };
      expect(corpo.data.fotoPrincipalVarianteId).toBe(variante.id);
    });

    it("rejeita variante sem foto como principal (400)", async () => {
      const produto = await criarProdutoViaHttp();
      const variante = await adicionarVarianteViaHttp(produto.id, { cor: "Grafite" }); // sem foto
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/foto-principal`, {
        method: "PATCH",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ varianteId: variante.id }),
      });
      expect(resposta.status).toBe(400);
    });

    it("aceita varianteId nulo para limpar a marcação", async () => {
      const produto = await criarProdutoViaHttp();
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produto.id}/foto-principal`, {
        method: "PATCH",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ varianteId: null }),
      });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { fotoPrincipalVarianteId: string | null } };
      expect(corpo.data.fotoPrincipalVarianteId).toBeNull();
    });
  });
});
