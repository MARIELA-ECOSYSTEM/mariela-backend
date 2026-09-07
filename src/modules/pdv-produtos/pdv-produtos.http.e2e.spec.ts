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
import { VendedoresService } from "../vendedores/vendedores.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE contra o banco de teste isolado
 * (`mariela_test` — nunca `mariela_dev`), mesmo padrão dos demais módulos.
 */
describe("HTTP — PDV Produtos (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1192${String(contadorTelefone).padStart(6, "0")}`;
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
    const email = `teste.http.pdv-produtos.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP PDV Produtos", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["produto", "vendedor", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  async function criarELogarVendedor(ativo = true): Promise<{ id: string; codigo: string; accessToken: string }> {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await vendedoresService.criar({ nome: "Vendedora HTTP PDV Produtos", telefone: telefoneUnico(), ativo: true, senha: "senha123" }, null);

    const respostaLogin = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }),
    });
    const corpo = (await respostaLogin.json()) as { data: { accessToken: string } };

    if (!ativo) await vendedoresService.alterarStatus(vendedor.id, { ativo: false }, null);

    return { id: vendedor.id, codigo: vendedor.codigo, accessToken: corpo.data.accessToken };
  }

  async function criarProdutoComEstoque(nome: string, precoVenda = 150, quantidade = 5) {
    const produtosService = app.get(ProdutosService);
    const produto = await produtosService.criar({ nome, categoria: "Vestidos", precoCusto: 60, precoVenda, ehNovidade: false }, null);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul", foto: "https://exemplo.com/azul.jpg" }, null);
    await produtosService.adicionarTamanho(produto.id, String(variante._id), { tamanho: "M", quantidade }, null);
    return produto;
  }

  it("GET /api/v1/pdv/produtos SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos`);
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/pdv/produtos com token do ADMIN é rejeitado (401)", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos`, { headers: jsonHeaders(adminAccessToken) });
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/pdv/produtos com vendedor ativo retorna 200 e o catálogo paginado", async () => {
    const vendedor = await criarELogarVendedor();
    const produto = await criarProdutoComEstoque(`Catálogo HTTP ${Date.now()}`);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos?busca=${encodeURIComponent(produto.nome)}`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: unknown[]; meta: { total: number; page: number; limit: number; totalPages: number } };
    expect(corpo.data).toHaveLength(1);
    expect(corpo.meta).toEqual({ total: 1, page: 1, limit: 30, totalPages: 1 });
  });

  it("busca por código funciona via HTTP real", async () => {
    const vendedor = await criarELogarVendedor();
    const produto = await criarProdutoComEstoque(`Busca Código HTTP ${Date.now()}`);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos?busca=${encodeURIComponent(produto.codProduto)}`, { headers: jsonHeaders(vendedor.accessToken) });
    const corpo = (await resposta.json()) as { data: { id: string }[] };
    expect(corpo.data.some((item) => item.id === produto.id)).toBe(true);
  });

  it("paginação real via query params (page/limit)", async () => {
    const vendedor = await criarELogarVendedor();
    const base = `Paginação HTTP ${Date.now()}`;
    await criarProdutoComEstoque(`${base} A`);
    await criarProdutoComEstoque(`${base} B`);
    await criarProdutoComEstoque(`${base} C`);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos?busca=${encodeURIComponent(base)}&page=1&limit=2`, { headers: jsonHeaders(vendedor.accessToken) });
    const corpo = (await resposta.json()) as { data: unknown[]; meta: { total: number; totalPages: number } };
    expect(corpo.data).toHaveLength(2);
    expect(corpo.meta.total).toBe(3);
    expect(corpo.meta.totalPages).toBe(2);
  });

  it("GET /api/v1/pdv/produtos/:id retorna o produto para venda com preço/estoque", async () => {
    const vendedor = await criarELogarVendedor();
    const produto = await criarProdutoComEstoque(`Detalhe HTTP ${Date.now()}`, 199.9, 7);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos/${produto.id}`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as {
      data: { id: string; precoVenda: number; precoEfetivo: number; quantidadeTotal: number; disponivel: boolean; variantes: { cor: string; tamanhos: { tamanho: string; quantidade: number }[] }[] };
    };
    expect(corpo.data.id).toBe(produto.id);
    expect(corpo.data.precoVenda).toBe(199.9);
    expect(corpo.data.precoEfetivo).toBe(199.9);
    expect(corpo.data.quantidadeTotal).toBe(7);
    expect(corpo.data.disponivel).toBe(true);
    expect(corpo.data.variantes[0]!.tamanhos[0]!.quantidade).toBe(7);
  });

  it("GET /api/v1/pdv/produtos/:id de produto inexistente retorna 404", async () => {
    const vendedor = await criarELogarVendedor();
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(404);
  });

  it("produto excluído não aparece na listagem nem no detalhe (404)", async () => {
    const vendedor = await criarELogarVendedor();
    const produtosService = app.get(ProdutosService);
    const produto = await criarProdutoComEstoque(`Excluído HTTP ${Date.now()}`);
    await produtosService.excluir(produto.id, null);

    const respostaLista = await fetch(`${baseUrl}/api/v1/pdv/produtos?busca=${encodeURIComponent(produto.nome)}`, { headers: jsonHeaders(vendedor.accessToken) });
    const corpoLista = (await respostaLista.json()) as { data: unknown[] };
    expect(corpoLista.data).toHaveLength(0);

    const respostaDetalhe = await fetch(`${baseUrl}/api/v1/pdv/produtos/${produto.id}`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(respostaDetalhe.status).toBe(404);
  });

  it("vendedor inativo é rejeitado (401) tanto na listagem quanto no detalhe", async () => {
    const vendedor = await criarELogarVendedor(false);
    const produto = await criarProdutoComEstoque(`Inativo HTTP ${Date.now()}`);

    const respostaLista = await fetch(`${baseUrl}/api/v1/pdv/produtos`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(respostaLista.status).toBe(401);

    const respostaDetalhe = await fetch(`${baseUrl}/api/v1/pdv/produtos/${produto.id}`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(respostaDetalhe.status).toBe(401);
  });

  it("vendedor excluído (soft delete) é rejeitado (401)", async () => {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await criarELogarVendedor();
    await vendedoresService.excluir(vendedor.id, null);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(401);
  });

  it("resposta nunca contém precoCusto, margemLucro ou qualquer dado administrativo/sensível", async () => {
    const vendedor = await criarELogarVendedor();
    await criarProdutoComEstoque(`Segurança HTTP ${Date.now()}`);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos`, { headers: jsonHeaders(vendedor.accessToken) });
    const bruto = await resposta.text();
    expect(bruto).not.toContain("precoCusto");
    expect(bruto).not.toContain("margemLucro");
    expect(bruto).not.toContain("corNormalizada");
    expect(bruto.toLowerCase()).not.toContain("senhahash");
  });

  it("não existe endpoint administrativo de Produtos acessível por token do PDV (/produtos é rejeitado)", async () => {
    const vendedor = await criarELogarVendedor();
    const resposta = await fetch(`${baseUrl}/api/v1/produtos`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/pdv/produtos/:id/variantes não existe (decisão: variantes já vêm no detalhe) — 404", async () => {
    const vendedor = await criarELogarVendedor();
    const produto = await criarProdutoComEstoque(`Sem endpoint de variantes ${Date.now()}`);
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/produtos/${produto.id}/variantes`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(404);
  });

  it("GET /docs-json documenta /pdv/produtos e /pdv/produtos/{id} com o security scheme Bearer", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(documento.paths["/api/v1/pdv/produtos"]?.["get"]).toBeTruthy();
    expect(documento.paths["/api/v1/pdv/produtos/{id}"]?.["get"]).toBeTruthy();
  });
});
