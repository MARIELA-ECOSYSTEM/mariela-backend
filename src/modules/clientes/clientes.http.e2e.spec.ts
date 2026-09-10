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
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendasService } from "../vendas/vendas.service.js";
import type { CriarVendedorDto } from "../vendedores/dto/criar-vendedor.dto.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global) — mesmo padrão de `auth.http.e2e.spec.ts`,
 * aplicado ao CRUD completo de Clientes.
 */
describe("HTTP — Clientes (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `8390${String(contadorTelefone).padStart(6, "0")}`;
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
    const email = `teste.http.clientes.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Clientes", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection("vendas").deleteMany({});
    await connection.collection("eventos_venda").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["cliente", "usuario", "venda", "produto", "vendedor", "caixa"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await app.close();
  });

  async function criarVendaParaCliente(clienteId: string) {
    const produtosService = app.get(ProdutosService);
    const vendedoresService = app.get(VendedoresService);
    const caixasService = app.get(CaixasService);
    const vendasService = app.get(VendasService);

    const produto = await produtosService.criar({ nome: `Produto HTTP Histórico ${Date.now()}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false }, null);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanho: "M", delta: 5, exigirExistente: false });
    const vendedorDto: CriarVendedorDto = { nome: "Vendedora HTTP Histórico", telefone: telefoneUnico(), ativo: true, senha: "senha123" };
    const vendedor = await vendedoresService.criar(vendedorDto, null);

    let caixaAtual = await caixasService.obterAtual();
    if (!caixaAtual) caixaAtual = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);

    return vendasService.criar(
      {
        clienteId,
        vendedorId: vendedor.id,
        caixaId: caixaAtual.id,
        itens: [{ produtoId: produto.id, varianteId: String(variante._id), tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      },
      null,
    );
  }

  it("GET /api/v1/clientes SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`);
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/clientes com payload inválido retorna 400 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "" }),
    });
    const corpo = (await resposta.json()) as { statusCode: number; code: string; errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
    expect(corpo.errors.some((erro) => erro.field === "nome" || erro.field === "telefone")).toBe(true);
  });

  // Etapa 18.8 — mass assignment: `codigo`, os agregados de compra e o soft
  // delete são campos internos/calculados (nunca fazem parte de `CriarClienteDto`).
  // O whitelist global (`forbidNonWhitelisted: true`) deve rejeitar o payload
  // inteiro (400) em vez de simplesmente ignorar os campos extras.
  it("POST /api/v1/clientes com campos internos/calculados no payload é rejeitado (400) pelo whitelist global — nunca usados como autoridade", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        nome: "Cliente Mass Assignment",
        telefone: telefoneUnico(),
        codigo: "CLI-9999",
        compras: 999,
        totalComprado: 999999,
        ultimaCompra: new Date().toISOString(),
        excluidoEm: null,
        telefoneNormalizado: "00000000000",
      }),
    });
    expect(resposta.status).toBe(400);
  });

  it("fluxo completo: criar → obter → listar (paginação/busca) → atualizar → excluir → 404", async () => {
    const telefone = telefoneUnico();
    const nome = `Cliente E2E ${Date.now()}`;

    const criacao = await fetch(`${baseUrl}/api/v1/clientes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome, telefone }),
    });
    expect(criacao.status).toBe(201);
    const corpoCriacao = (await criacao.json()) as { data: { id: string; codigo: string } };
    const clienteId = corpoCriacao.data.id;
    expect(corpoCriacao.data.codigo).toMatch(/^CLI-\d{4}$/);

    const obtido = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}`, { headers: authHeaders() });
    expect(obtido.status).toBe(200);

    const listagem = await fetch(`${baseUrl}/api/v1/clientes?busca=${encodeURIComponent(nome)}&page=1&limit=20`, {
      headers: authHeaders(),
    });
    const corpoListagem = (await listagem.json()) as {
      data: unknown[];
      meta: { total: number; page: number; limit: number; totalPages: number };
      facets: Record<string, { valor: string; count: number }[]>;
    };
    expect(listagem.status).toBe(200);
    expect(corpoListagem.data).toHaveLength(1);
    expect(corpoListagem.meta).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
    expect(corpoListagem.facets["historico"]).toBeTruthy();

    const atualizacao = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ nome: `${nome} Atualizado`, telefone }),
    });
    const corpoAtualizacao = (await atualizacao.json()) as { data: { nome: string } };
    expect(atualizacao.status).toBe(200);
    expect(corpoAtualizacao.data.nome).toBe(`${nome} Atualizado`);

    const vendas = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}/vendas`, { headers: authHeaders() });
    const corpoVendas = (await vendas.json()) as { data: unknown[] };
    expect(vendas.status).toBe(200);
    expect(corpoVendas.data).toEqual([]);

    const exclusao = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}`, { method: "DELETE", headers: authHeaders() });
    expect(exclusao.status).toBe(200);

    const apos = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}`, { headers: authHeaders() });
    expect(apos.status).toBe(404);

    const listaApos = await fetch(`${baseUrl}/api/v1/clientes?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
    const corpoListaApos = (await listaApos.json()) as { data: unknown[] };
    expect(corpoListaApos.data).toHaveLength(0);
  });

  describe("GET /clientes: contrato duplo retrocompatível (Etapa 13.2)", () => {
    it("SEM nenhum query param: devolve o array COMPLETO de clientes ativos, sem meta/facets (contrato legado do Backoffice)", async () => {
      const nome = `Legado ${Date.now()}`;
      const criacao = await fetch(`${baseUrl}/api/v1/clientes`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico() }),
      });
      const clienteId = ((await criacao.json()) as { data: { id: string } }).data.id;

      const resposta = await fetch(`${baseUrl}/api/v1/clientes`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { id: string; nome: string }[]; meta?: unknown; facets?: unknown };
      expect(Array.isArray(corpo.data)).toBe(true);
      expect(corpo.meta).toBeUndefined();
      expect(corpo.facets).toBeUndefined();
      expect(corpo.data.some((cliente) => cliente.id === clienteId)).toBe(true);
    });

    it("COM page/limit: preserva o contrato paginado/facetado já existente", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/clientes?page=1&limit=1`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: unknown[]; meta: { total: number; page: number; limit: number }; facets: Record<string, unknown> };
      expect(corpo.data.length).toBeLessThanOrEqual(1);
      expect(corpo.meta).toBeTruthy();
      expect(corpo.meta.page).toBe(1);
      expect(corpo.meta.limit).toBe(1);
      expect(corpo.facets).toBeTruthy();
    });

    it("COM apenas busca (sem page/limit explícitos): continua no contrato paginado/facetado, nunca no legado", async () => {
      const nome = `SoBusca ${Date.now()}`;
      await fetch(`${baseUrl}/api/v1/clientes`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico() }),
      });
      const resposta = await fetch(`${baseUrl}/api/v1/clientes?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: { nome: string }[]; meta: { total: number } };
      expect(corpo.meta).toBeTruthy(); // presença de QUALQUER param já ativa o contrato paginado
      expect(corpo.data).toHaveLength(1);
    });

    it("clientes soft-deleted continuam excluídos tanto no modo legado quanto no paginado", async () => {
      const nome = `SoftDel ${Date.now()}`;
      const criacao = await fetch(`${baseUrl}/api/v1/clientes`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico() }),
      });
      const clienteId = ((await criacao.json()) as { data: { id: string } }).data.id;
      await fetch(`${baseUrl}/api/v1/clientes/${clienteId}`, { method: "DELETE", headers: authHeaders() });

      const legado = await fetch(`${baseUrl}/api/v1/clientes`, { headers: authHeaders() });
      const corpoLegado = (await legado.json()) as { data: { id: string }[] };
      expect(corpoLegado.data.some((cliente) => cliente.id === clienteId)).toBe(false);

      const paginado = await fetch(`${baseUrl}/api/v1/clientes?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
      const corpoPaginado = (await paginado.json()) as { data: { id: string }[] };
      expect(corpoPaginado.data.some((cliente) => cliente.id === clienteId)).toBe(false);
    });

    it("PDV (/pdv/clientes) continua funcionando com paginação real, sem nenhuma interferência do contrato legado do Backoffice", async () => {
      const vendedoresService = app.get(VendedoresService);
      const vendedor = await vendedoresService.criar({ nome: "Vendedora HTTP Clientes PDV", telefone: telefoneUnico(), ativo: true, senha: "senha123" }, null);
      const loginPdv = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }),
      });
      const tokenPdv = ((await loginPdv.json()) as { data: { accessToken: string } }).data.accessToken;

      const resposta = await fetch(`${baseUrl}/api/v1/pdv/clientes?page=1&limit=5`, {
        headers: { authorization: `Bearer ${tokenPdv}`, "content-type": "application/json" },
      });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: unknown[]; meta: { page: number; limit: number } };
      expect(corpo.meta.page).toBe(1);
      expect(corpo.meta.limit).toBe(5);
    });
  });

  describe("GET /clientes/:id/vendas: histórico real (Etapa 13.2)", () => {
    it("SEM token retorna 401", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/clientes/65f1a2b3c4d5e6f7a8b9c0d1/vendas`);
      expect(resposta.status).toBe(401);
    });

    it("estrutura da resposta é exatamente compatível com VendaResumo — sem campos internos vazados", async () => {
      const criacao = await fetch(`${baseUrl}/api/v1/clientes`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome: `Cliente Histórico HTTP ${Date.now()}`, telefone: telefoneUnico() }),
      });
      const clienteId = ((await criacao.json()) as { data: { id: string } }).data.id;
      await criarVendaParaCliente(clienteId);

      const resposta = await fetch(`${baseUrl}/api/v1/clientes/${clienteId}/vendas`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: Record<string, unknown>[]; meta: { total: number } };
      expect(corpo.data).toHaveLength(1);
      expect(corpo.meta.total).toBe(1);

      const CAMPOS_ESPERADOS = [
        "id", "codigo", "numero", "dataVenda", "clienteId", "clienteNome", "vendedorId", "vendedorNome",
        "caixaId", "caixaCodigo", "totalItens", "valorBruto", "descontoPromocional", "descontoVenda",
        "descontoTotal", "valorFinal", "valorPago", "valorPendente", "valorDevolvido", "temPromocao",
        "temDesconto", "formaPagamento", "totalParcelas", "parcelasPagas", "status",
      ].sort();
      expect(Object.keys(corpo.data[0]!).sort()).toEqual(CAMPOS_ESPERADOS);
      // Nunca expõe detalhe pesado nem campos internos.
      for (const campoProibido of ["itens", "pagamentos", "parcelas", "historico", "cancelamento", "observacao", "idempotencyKey", "criadoEm", "atualizadoEm", "_id", "__v"]) {
        expect(corpo.data[0]![campoProibido]).toBeUndefined();
      }
    });
  });

  it("POST /api/v1/clientes com telefone duplicado retorna 409", async () => {
    const telefone = telefoneUnico();
    await fetch(`${baseUrl}/api/v1/clientes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Duplicado Um", telefone }),
    });
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Duplicado Dois", telefone }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(409);
    expect(corpo.code).toBe("CONFLICT");
  });

  it("GET /api/v1/clientes/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/clientes/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: authHeaders() });
    expect(resposta.status).toBe(404);
  });

  it("GET /api/v1/clientes com token malformado/inválido retorna 401", async () => {
    // Não existe hoje nenhuma role além de ADMIN no sistema (ver `common/types/role.type.ts`),
    // então um teste genuíno de 403 (role válida, mas insuficiente) não é
    // possível ainda — documentado como pendência no relatório final.
    const resposta = await fetch(`${baseUrl}/api/v1/clientes`, {
      headers: { authorization: "Bearer token-invalido-sem-role" },
    });
    expect(resposta.status).toBe(401);
  });

  it("GET /docs-json documenta as rotas de Clientes com BearerAuth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining(["/api/v1/clientes", "/api/v1/clientes/{id}", "/api/v1/clientes/{id}/vendas"]),
    );
  });
});
