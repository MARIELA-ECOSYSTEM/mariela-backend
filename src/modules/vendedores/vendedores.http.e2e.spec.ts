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

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, mesmo pipeline de
 * exceções, mesmo prefixo global) — mesmo padrão de `clientes.http.e2e.spec.ts`,
 * aplicado ao CRUD completo de Vendedores.
 */
describe("HTTP — Vendedores (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let accessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1190${String(contadorTelefone).padStart(6, "0")}`;
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
    const email = `teste.http.vendedores.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Vendedores", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    accessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendas").deleteMany({});
    await connection.collection("eventos_venda").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["vendedor", "usuario", "venda", "produto", "caixa"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  async function criarVendaParaVendedor(vendedorId: string) {
    const produtosService = app.get(ProdutosService);
    const caixasService = app.get(CaixasService);
    const vendasService = app.get(VendasService);

    const produto = await produtosService.criar({ nome: `Produto HTTP Histórico Vendedor ${Date.now()}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false }, null);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanho: "M", delta: 5, exigirExistente: false });

    let caixaAtual = await caixasService.obterAtual();
    if (!caixaAtual) caixaAtual = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);

    return vendasService.criar(
      {
        vendedorId,
        caixaId: caixaAtual.id,
        itens: [{ produtoId: produto.id, varianteId: String(variante._id), tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      },
      null,
    );
  }

  it("GET /api/v1/vendedores SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendedores`);
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/vendedores com payload inválido retorna 400 no envelope de erro", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "" }),
    });
    const corpo = (await resposta.json()) as { statusCode: number; code: string; errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");
    expect(corpo.errors.some((erro) => erro.field === "nome" || erro.field === "telefone")).toBe(true);
  });

  it("POST /api/v1/vendedores sem senha retorna 400", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Sem Senha", telefone: telefoneUnico(), ativo: true }),
    });
    const corpo = (await resposta.json()) as { errors: { field: string }[] };
    expect(resposta.status).toBe(400);
    expect(corpo.errors.some((erro) => erro.field === "senha")).toBe(true);
  });

  it("fluxo completo: criar → obter → listar (paginação/busca) → status → senha → vendas → atualizar → excluir → 404", async () => {
    const telefone = telefoneUnico();
    const nome = `Vendedor E2E ${Date.now()}`;

    const criacao = await fetch(`${baseUrl}/api/v1/vendedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome, telefone, ativo: true, senha: "senha123" }),
    });
    expect(criacao.status).toBe(201);
    const corpoCriacao = (await criacao.json()) as { data: { id: string; codigo: string } };
    const vendedorId = corpoCriacao.data.id;
    expect(corpoCriacao.data.codigo).toMatch(/^VEN-\d{4}$/);

    const obtido = await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}`, { headers: authHeaders() });
    const corpoObtido = (await obtido.json()) as { data: Record<string, unknown> };
    expect(obtido.status).toBe(200);
    expect(corpoObtido.data["senhaHash"]).toBeUndefined();
    expect(corpoObtido.data["senha"]).toBeUndefined();

    const listagem = await fetch(`${baseUrl}/api/v1/vendedores?busca=${encodeURIComponent(nome)}&page=1&limit=20`, {
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
    expect(corpoListagem.facets["status"]).toBeTruthy();

    const status = await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}/status`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ ativo: false }),
    });
    const corpoStatus = (await status.json()) as { data: { ativo: boolean } };
    expect(status.status).toBe(200);
    expect(corpoStatus.data.ativo).toBe(false);

    const senha = await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}/senha`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ senha: "senhaNova123" }),
    });
    expect(senha.status).toBe(200);

    const senhaCurta = await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}/senha`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ senha: "123" }),
    });
    expect(senhaCurta.status).toBe(400);

    const vendas = await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}/vendas`, { headers: authHeaders() });
    const corpoVendas = (await vendas.json()) as { data: unknown[] };
    expect(vendas.status).toBe(200);
    expect(corpoVendas.data).toEqual([]);

    const atualizacao = await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ nome: `${nome} Atualizado`, telefone, ativo: true }),
    });
    const corpoAtualizacao = (await atualizacao.json()) as { data: { nome: string; ativo: boolean } };
    expect(atualizacao.status).toBe(200);
    expect(corpoAtualizacao.data.nome).toBe(`${nome} Atualizado`);
    expect(corpoAtualizacao.data.ativo).toBe(true);

    const exclusao = await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}`, { method: "DELETE", headers: authHeaders() });
    expect(exclusao.status).toBe(200);

    const apos = await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}`, { headers: authHeaders() });
    expect(apos.status).toBe(404);

    const listaApos = await fetch(`${baseUrl}/api/v1/vendedores?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
    const corpoListaApos = (await listaApos.json()) as { data: unknown[] };
    expect(corpoListaApos.data).toHaveLength(0);
  });

  it("POST /api/v1/vendedores com telefone duplicado retorna 409", async () => {
    const telefone = telefoneUnico();
    await fetch(`${baseUrl}/api/v1/vendedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Duplicado Um", telefone, ativo: true, senha: "senha123" }),
    });
    const resposta = await fetch(`${baseUrl}/api/v1/vendedores`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ nome: "Duplicado Dois", telefone, ativo: true, senha: "senha123" }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(409);
    expect(corpo.code).toBe("CONFLICT");
  });

  it("GET /api/v1/vendedores/:id inexistente retorna 404", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendedores/65f1a2b3c4d5e6f7a8b9c0d1`, { headers: authHeaders() });
    expect(resposta.status).toBe(404);
  });

  describe("GET /vendedores: contrato duplo retrocompatível (Etapa 17.2)", () => {
    it("SEM nenhum query param: devolve o array COMPLETO de vendedores ativos, sem meta/facets, sem truncar em 20 (contrato legado do Backoffice)", async () => {
      const prefixo = `Legado${Date.now()}`;
      await Promise.all(
        Array.from({ length: 21 }, (_, indice) =>
          fetch(`${baseUrl}/api/v1/vendedores`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ nome: `${prefixo} ${indice}`, telefone: telefoneUnico(), ativo: true, senha: "senha123" }),
          }),
        ),
      );

      const resposta = await fetch(`${baseUrl}/api/v1/vendedores`, { headers: authHeaders() });
      expect(resposta.status).toBe(200);
      const corpo = (await resposta.json()) as { data: { nome: string }[]; meta?: unknown; facets?: unknown };
      expect(Array.isArray(corpo.data)).toBe(true);
      expect(corpo.meta).toBeUndefined();
      expect(corpo.facets).toBeUndefined();
      expect(corpo.data.filter((vendedor) => vendedor.nome.startsWith(prefixo))).toHaveLength(21); // nunca truncado em 20 (LIMITE_PADRAO)
    });

    it("COM page/limit: preserva o contrato paginado/facetado já existente", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/vendedores?page=1&limit=1`, { headers: authHeaders() });
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
      await fetch(`${baseUrl}/api/v1/vendedores`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico(), ativo: true, senha: "senha123" }),
      });
      const resposta = await fetch(`${baseUrl}/api/v1/vendedores?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: { nome: string }[]; meta: { total: number } };
      expect(corpo.meta).toBeTruthy(); // presença de QUALQUER param já ativa o contrato paginado
      expect(corpo.data).toHaveLength(1);
    });

    it("vendedores soft-deleted continuam excluídos tanto no modo legado quanto no paginado", async () => {
      const nome = `SoftDel ${Date.now()}`;
      const criacao = await fetch(`${baseUrl}/api/v1/vendedores`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico(), ativo: true, senha: "senha123" }),
      });
      const vendedorId = ((await criacao.json()) as { data: { id: string } }).data.id;
      await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}`, { method: "DELETE", headers: authHeaders() });

      const legado = await fetch(`${baseUrl}/api/v1/vendedores`, { headers: authHeaders() });
      const corpoLegado = (await legado.json()) as { data: { id: string }[] };
      expect(corpoLegado.data.some((vendedor) => vendedor.id === vendedorId)).toBe(false);

      const paginado = await fetch(`${baseUrl}/api/v1/vendedores?busca=${encodeURIComponent(nome)}`, { headers: authHeaders() });
      const corpoPaginado = (await paginado.json()) as { data: { id: string }[] };
      expect(corpoPaginado.data.some((vendedor) => vendedor.id === vendedorId)).toBe(false);
    });

    it("array completo continua compatível com o formato consumido por vendedoresApi.listar() (sem senha/senhaHash)", async () => {
      const nome = `Compat ${Date.now()}`;
      await fetch(`${baseUrl}/api/v1/vendedores`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome, telefone: telefoneUnico(), ativo: true, senha: "senha123" }),
      });

      const resposta = await fetch(`${baseUrl}/api/v1/vendedores`, { headers: authHeaders() });
      const corpo = (await resposta.json()) as { data: Record<string, unknown>[] };
      const encontrado = corpo.data.find((vendedor) => vendedor["nome"] === nome)!;
      expect(encontrado["senha"]).toBeUndefined();
      expect(encontrado["senhaHash"]).toBeUndefined();
      expect(encontrado["telefoneNormalizado"]).toBeUndefined();
    });
  });

  describe("GET /vendedores/:id/vendas: histórico real (Etapa 17.2)", () => {
    it("SEM token retorna 401", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/vendedores/65f1a2b3c4d5e6f7a8b9c0d1/vendas`);
      expect(resposta.status).toBe(401);
    });

    it("estrutura da resposta é exatamente compatível com VendaResumo — sem campos internos vazados", async () => {
      const criacao = await fetch(`${baseUrl}/api/v1/vendedores`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ nome: `Vendedor Histórico HTTP ${Date.now()}`, telefone: telefoneUnico(), ativo: true, senha: "senha123" }),
      });
      const vendedorId = ((await criacao.json()) as { data: { id: string } }).data.id;
      await criarVendaParaVendedor(vendedorId);

      const resposta = await fetch(`${baseUrl}/api/v1/vendedores/${vendedorId}/vendas`, { headers: authHeaders() });
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
      expect(corpo.data[0]!["vendedorId"]).toBe(vendedorId);
      // Nunca expõe detalhe pesado nem campos internos.
      for (const campoProibido of ["itens", "pagamentos", "parcelas", "historico", "cancelamento", "observacao", "idempotencyKey", "criadoEm", "atualizadoEm", "_id", "__v"]) {
        expect(corpo.data[0]![campoProibido]).toBeUndefined();
      }
    });
  });

  it("GET /api/v1/vendedores com token malformado/inválido retorna 401", async () => {
    // Não existe papel VENDEDOR no `Role`/JWT do Backoffice (ver `role.type.ts`
    // — vendedor não é `Usuario`, autenticação do PDV é um fluxo futuro e
    // separado), então um teste genuíno de 403 (role válida, insuficiente)
    // não é possível ainda — mesma pendência já documentada em Clientes.
    const resposta = await fetch(`${baseUrl}/api/v1/vendedores`, {
      headers: { authorization: "Bearer token-invalido-sem-role" },
    });
    expect(resposta.status).toBe(401);
  });

  it("GET /docs-json documenta as rotas de Vendedores com BearerAuth", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(documento.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/vendedores",
        "/api/v1/vendedores/{id}",
        "/api/v1/vendedores/{id}/vendas",
        "/api/v1/vendedores/{id}/status",
        "/api/v1/vendedores/{id}/senha",
      ]),
    );
  });
});
