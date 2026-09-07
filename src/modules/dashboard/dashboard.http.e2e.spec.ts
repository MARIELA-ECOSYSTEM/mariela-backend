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
import { CaixasService } from "../caixas/caixas.service.js";
import { ClientesService } from "../clientes/clientes.service.js";
import { FornecedoresService } from "../fornecedores/fornecedores.service.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendasService } from "../vendas/vendas.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { chaveMes } from "./dashboard.util.js";
import type { ResumoDashboard } from "./dashboard.types.js";

/**
 * Sobe a aplicação HTTP DE VERDADE contra o banco de teste isolado
 * (`mariela_test` — nunca `mariela_dev`, ver `MONGODB_URI_TESTE`), mesmo
 * padrão dos demais módulos (`vendas.http.e2e.spec.ts`).
 */
describe("HTTP — Dashboard (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(prefixo: string): string {
    contadorTelefone += 1;
    return `${prefixo}${String(contadorTelefone).padStart(6, "0")}`;
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
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
    const email = `teste.http.dashboard.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Dashboard", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("vendas").deleteMany({});
    await connection.collection("eventos_venda").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection("fornecedores").deleteMany({});
    await connection.collection("eventos_fornecedor").deleteMany({});
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["venda", "produto", "vendedor", "cliente", "fornecedor", "caixa", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("GET /api/v1/dashboard/resumo SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/dashboard/resumo`);
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/dashboard/resumo com banco vazio retorna 200 com indicadores zerados", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/dashboard/resumo`, { headers: authHeaders() });
    const corpo = (await resposta.json()) as { data: ResumoDashboard };
    expect(resposta.status).toBe(200);
    expect(corpo.data.demonstracao).toBe(false);
    expect(corpo.data.vendas.vendasMes).toBe(0);
    expect(corpo.data.vendas.faturamentoMes).toBe(0);
    expect(corpo.data.vendedores.ranking).toEqual([]);
  });

  describe("com dados seedados (mecanismo interno)", () => {
    let valorVenda: number;

    beforeAll(async () => {
      const produtosService = app.get(ProdutosService);
      const vendedoresService = app.get(VendedoresService);
      const clientesService = app.get(ClientesService);
      const fornecedoresService = app.get(FornecedoresService);
      const caixasService = app.get(CaixasService);
      const vendasService = app.get(VendasService);

      const fornecedor = await fornecedoresService.criar({ nome: "Fornecedor HTTP Dashboard" }, null);
      const produto = await produtosService.criar(
        { nome: "Produto HTTP Dashboard", categoria: "Vestidos", precoCusto: 80, precoVenda: 200, ehNovidade: false, fornecedorId: fornecedor.id },
        null,
      );
      const variante = await produtosService.adicionarVariante(produto.id, { cor: "Preto" }, null);
      const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanho: "P", delta: 10, exigirExistente: false });
      const vendedor = await vendedoresService.criar({ nome: "Vendedora HTTP Dashboard", telefone: telefoneUnico("1199"), ativo: true, senha: "senha123" }, null);
      const cliente = await clientesService.criar({ nome: "Cliente HTTP Dashboard", telefone: telefoneUnico("8399") }, null);
      const caixa = await caixasService.abrir({ valorInicial: 500, observacao: "" }, null);

      valorVenda = 200;
      await vendasService.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.id, varianteId: String(variante._id), tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: valorVenda }],
        },
        null,
      );
      await caixasService.fechar(caixa.id, { valorInformado: 500 + valorVenda }, null);
    });

    it("GET /api/v1/dashboard/resumo reflete a venda, o estoque, o cliente, o fornecedor e o vendedor seedados", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/dashboard/resumo`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: ResumoDashboard };
      expect(resposta.status).toBe(200);

      expect(corpo.data.vendas.vendasHoje).toBeGreaterThanOrEqual(1);
      expect(corpo.data.vendas.faturamentoMes).toBeGreaterThanOrEqual(valorVenda);
      expect(corpo.data.vendas.ultimasVendas.some((v) => v.valorFinal === valorVenda && v.status === "concluida")).toBe(true);

      expect(corpo.data.estoque.produtosCadastrados).toBeGreaterThanOrEqual(1);
      expect(corpo.data.estoque.vendaPotencial).toBeGreaterThan(0);

      expect(corpo.data.clientes.compraramNoMes).toBeGreaterThanOrEqual(1);
      expect(corpo.data.fornecedores.ativos).toBeGreaterThanOrEqual(1);
      expect(corpo.data.vendedores.ranking.some((r) => r.faturamento === valorVenda)).toBe(true);
    });

    it("GET /api/v1/dashboard/resumo?mes=<mês atual> devolve o mesmo resultado que sem parâmetro", async () => {
      const mesAtual = chaveMes(new Date());
      const [semParametro, comParametro] = await Promise.all([
        fetch(`${baseUrl}/api/v1/dashboard/resumo`, { headers: authHeaders() }),
        fetch(`${baseUrl}/api/v1/dashboard/resumo?mes=${mesAtual}`, { headers: authHeaders() }),
      ]);
      const corpoSemParametro = (await semParametro.json()) as { data: ResumoDashboard };
      const corpoComParametro = (await comParametro.json()) as { data: ResumoDashboard };
      expect(comParametro.status).toBe(200);
      expect(corpoComParametro.data.vendas.mesReferencia).toBe(mesAtual);
      expect(corpoComParametro.data.vendas.faturamentoMes).toBe(corpoSemParametro.data.vendas.faturamentoMes);
    });

    it("GET /api/v1/dashboard/resumo?mes=<fora do intervalo> cai no mês atual", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/dashboard/resumo?mes=1999-01`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: ResumoDashboard };
      expect(resposta.status).toBe(200);
      expect(corpo.data.vendas.mesReferencia).toBe(chaveMes(new Date()));
    });
  });

  it("GET /docs-json documenta GET /dashboard/resumo", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(documento.paths["/api/v1/dashboard/resumo"]?.["get"]).toBeTruthy();
    expect(documento.paths["/api/v1/dashboard/resumo"]?.["post"]).toBeUndefined();
  });
});
