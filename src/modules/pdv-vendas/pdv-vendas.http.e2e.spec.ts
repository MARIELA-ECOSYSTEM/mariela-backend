import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { AddressInfo } from "node:net";
import type { Connection } from "mongoose";
import { randomUUID } from "node:crypto";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "../auth/auth.service.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE contra o banco de teste isolado
 * (`mariela_test` — nunca `mariela_dev`), mesmo padrão dos demais módulos.
 * Cobre o núcleo transacional do PDV: criação de venda ponta-a-ponta, com
 * idempotência real (sequencial e concorrente) e concorrência de estoque.
 */
describe("HTTP — PDV Vendas (integração — servidor real)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminAccessToken: string;
  let contadorTelefone = 0;

  function telefoneUnico(): string {
    contadorTelefone += 1;
    return `1191${String(contadorTelefone).padStart(6, "0")}`;
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
    const email = `teste.http.pdv-vendas.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP PDV Vendas", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("vendas").deleteMany({});
    await connection.collection("eventos_venda").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("adquirentes").deleteMany({});
    await connection.collection("eventos_adquirente").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["venda", "produto", "vendedor", "caixa", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  async function fecharCaixaAbertoSeExistir(): Promise<void> {
    const caixasService = app.get(CaixasService);
    const atual = await caixasService.obterAtual();
    if (atual) await caixasService.fechar(atual.id, { valorInformado: atual.resumo.saldoEsperado }, null);
  }

  async function criarELogarVendedor(ativo = true): Promise<{ id: string; codigo: string; accessToken: string }> {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await vendedoresService.criar({ nome: "Vendedora HTTP PDV Vendas", telefone: telefoneUnico(), ativo: true, senha: "senha123" }, null);
    const respostaLogin = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }),
    });
    const corpo = (await respostaLogin.json()) as { data: { accessToken: string } };
    if (!ativo) await vendedoresService.alterarStatus(vendedor.id, { ativo: false }, null);
    return { id: vendedor.id, codigo: vendedor.codigo, accessToken: corpo.data.accessToken };
  }

  async function criarProdutoComEstoque(precoVenda: number, quantidade: number) {
    const produtosService = app.get(ProdutosService);
    const produto = await produtosService.criar({ nome: `Produto HTTP PDV Vendas ${Date.now()}`, categoria: "Vestidos", precoCusto: precoVenda / 2, precoVenda, ehNovidade: false }, null);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const varianteId = String(variante._id);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, varianteId, { tamanho: "M", delta: quantidade, exigirExistente: false });
    return { produtoId: produto.id, varianteId, tamanhoId };
  }

  async function abrirCaixaViaPdv(token: string, valorInicial = 1000): Promise<string> {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/caixa/abertura`, { method: "POST", headers: jsonHeaders(token), body: JSON.stringify({ valorInicial }) });
    const corpo = (await resposta.json()) as { data: { id: string } };
    return corpo.data.id;
  }

  async function criarAdquirenteViaHttp(
    tabelaTarifas: { modalidade: "debito" | "credito"; parcelas: number; percentual: number }[],
    ativo = true,
  ): Promise<string> {
    const resposta = await fetch(`${baseUrl}/api/v1/adquirentes`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ nome: `Adquirente HTTP PDV Vendas ${Date.now()}-${Math.random()}`, ativo, tabelaTarifas }),
    });
    const corpo = (await resposta.json()) as { data: { id: string } };
    return corpo.data.id;
  }

  it("POST /api/v1/pdv/vendas SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, { method: "POST", headers: jsonHeaders(), body: "{}" });
    expect(resposta.status).toBe(401);
  });

  it("POST /api/v1/pdv/vendas com token do ADMIN é rejeitado (401)", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, { method: "POST", headers: jsonHeaders(adminAccessToken), body: "{}" });
    expect(resposta.status).toBe(401);
  });

  it("sem caixa aberto, a criação é rejeitada com 400", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      }),
    });
    expect(resposta.status).toBe(400);
  });

  it("payload com vendedorId ou caixaId é rejeitado (400) pelo whitelist global — nunca usado como autoridade", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const comVendedorId = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        vendedorId: "65f1a2b3c4d5e6f7a8b9c0d1",
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      }),
    });
    expect(comVendedorId.status).toBe(400);

    const comCaixaId = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        caixaId: "65f1a2b3c4d5e6f7a8b9c0d1",
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      }),
    });
    expect(comCaixaId.status).toBe(400);

    await fecharCaixaAbertoSeExistir();
  });

  it("fluxo completo: login → abrir caixa → criar venda → consultar pelo Backoffice → confirmar estoque/caixa/vendedor", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    const caixaId = await abrirCaixaViaPdv(vendedor.accessToken, 1000);
    const produto = await criarProdutoComEstoque(199.9, 5);

    const respostaVenda = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }],
        pagamentos: [{ forma: "PIX", valor: 399.8 }],
      }),
    });
    expect(respostaVenda.status).toBe(201);
    const corpoVenda = (await respostaVenda.json()) as {
      data: { id: string; codigo: string; status: string; valorFinal: number; valorPago: number; valorPendente: number; vendedorId: string; caixaId: string; itens: unknown[] };
    };
    expect(corpoVenda.data.status).toBe("concluida");
    expect(corpoVenda.data.valorFinal).toBe(399.8);
    expect(corpoVenda.data.valorPago).toBe(399.8);
    expect(corpoVenda.data.valorPendente).toBe(0);
    expect(corpoVenda.data.vendedorId).toBe(vendedor.id);
    expect(corpoVenda.data.caixaId).toBe(caixaId);

    // Backoffice (ADMIN) continua enxergando a venda normalmente.
    const respostaAdmin = await fetch(`${baseUrl}/api/v1/vendas/${corpoVenda.data.id}`, { headers: jsonHeaders(adminAccessToken) });
    expect(respostaAdmin.status).toBe(200);
    const corpoAdmin = (await respostaAdmin.json()) as { data: { codigo: string } };
    expect(corpoAdmin.data.codigo).toBe(corpoVenda.data.codigo);

    // Estoque baixado.
    const produtoAtualizado = await app.get(ProdutosService).obterPorId(produto.produtoId);
    const tamanho = produtoAtualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
    expect(tamanho.quantidade).toBe(3);

    // Caixa recebeu o movimento.
    const caixasService = app.get(CaixasService);
    const detalheCaixa = await caixasService.obterDetalhe(caixaId);
    expect(detalheCaixa.resumo.totalVendas).toBe(399.8);

    // Vendedor teve os agregados atualizados.
    const vendedoresService = app.get(VendedoresService);
    const vendedorAtualizado = await vendedoresService.obterPorId(vendedor.id);
    expect(vendedorAtualizado.vendas).toBe(1);
    expect(vendedorAtualizado.totalVendido).toBe(399.8);

    await caixasService.fechar(caixaId, { valorInformado: 1399.8 }, null);
  });

  it("idempotência: retry sequencial com a mesma chave devolve a MESMA venda (201 nas duas vezes)", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);
    const payload = JSON.stringify({
      idempotencyKey: randomUUID(),
      itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
      pagamentos: [{ forma: "Dinheiro", valor: 100 }],
    });

    const primeira = await fetch(`${baseUrl}/api/v1/pdv/vendas`, { method: "POST", headers: jsonHeaders(vendedor.accessToken), body: payload });
    const segunda = await fetch(`${baseUrl}/api/v1/pdv/vendas`, { method: "POST", headers: jsonHeaders(vendedor.accessToken), body: payload });
    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(201);
    const corpoPrimeira = (await primeira.json()) as { data: { id: string } };
    const corpoSegunda = (await segunda.json()) as { data: { id: string } };
    expect(corpoSegunda.data.id).toBe(corpoPrimeira.data.id);

    const totalVendas = await connection.collection("vendas").countDocuments({ idempotencyKey: JSON.parse(payload).idempotencyKey });
    expect(totalVendas).toBe(1);

    await fecharCaixaAbertoSeExistir();
  });

  it("idempotência: duas requisições HTTP CONCORRENTES com a mesma chave resultam em UMA única venda", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(120, 5);
    const payload = JSON.stringify({
      idempotencyKey: randomUUID(),
      itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
      pagamentos: [{ forma: "Dinheiro", valor: 120 }],
    });

    const enviar = () => fetch(`${baseUrl}/api/v1/pdv/vendas`, { method: "POST", headers: jsonHeaders(vendedor.accessToken), body: payload });
    const [a, b] = await Promise.all([enviar(), enviar()]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const corpoA = (await a.json()) as { data: { id: string } };
    const corpoB = (await b.json()) as { data: { id: string } };
    expect(corpoA.data.id).toBe(corpoB.data.id);

    const totalVendas = await connection.collection("vendas").countDocuments({ idempotencyKey: JSON.parse(payload).idempotencyKey });
    expect(totalVendas).toBe(1);

    const produtoAtualizado = await app.get(ProdutosService).obterPorId(produto.produtoId);
    expect(produtoAtualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(4); // baixou 1, não 2

    await fecharCaixaAbertoSeExistir();
  });

  it("concorrência de estoque: duas vendas (chaves diferentes) disputando a ÚLTIMA unidade — uma 201, uma 400, estoque final 0", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 1);

    const montarPayload = () =>
      JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      });

    const [a, b] = await Promise.all([
      fetch(`${baseUrl}/api/v1/pdv/vendas`, { method: "POST", headers: jsonHeaders(vendedor.accessToken), body: montarPayload() }),
      fetch(`${baseUrl}/api/v1/pdv/vendas`, { method: "POST", headers: jsonHeaders(vendedor.accessToken), body: montarPayload() }),
    ]);
    const status = [a.status, b.status].sort();
    expect(status).toEqual([201, 400]);

    const produtoAtualizado = await app.get(ProdutosService).obterPorId(produto.produtoId);
    expect(produtoAtualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(0);

    await fecharCaixaAbertoSeExistir();
  });

  it("vendedor inativo é rejeitado (401) ao tentar criar venda", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedorAtivoParaAbrirCaixa = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedorAtivoParaAbrirCaixa.accessToken);
    const vendedorInativo = await criarELogarVendedor(false);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedorInativo.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      }),
    });
    expect(resposta.status).toBe(401);

    await fecharCaixaAbertoSeExistir();
  });

  it("um JWT do PDV é rejeitado em /vendas (rota administrativa)", async () => {
    const vendedor = await criarELogarVendedor();
    const resposta = await fetch(`${baseUrl}/api/v1/vendas`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(401);
  });

  it("continua não existindo POST /api/v1/vendas no namespace administrativo", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/vendas`, { method: "POST", headers: jsonHeaders(adminAccessToken), body: "{}" });
    expect(resposta.status).toBe(404);
  });

  it("Etapa 10.3: desconto por item (%) + desconto da venda (formato novo {tipo,valor}) via HTTP real", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [
          {
            produtoId: produto.produtoId,
            varianteId: produto.varianteId,
            tamanhoId: produto.tamanhoId,
            quantidade: 2,
            desconto: { tipo: "percentual", valor: 10 },
          },
        ],
        // base do item = 100×2=200; 10% = 20; subtotalItem = 180.
        // subtotalVenda = 180; desconto venda R$18 (formato objeto); valorFinal=162.
        descontoVenda: { tipo: "valor", valor: 18 },
        pagamentos: [],
      }),
    });
    expect(resposta.status).toBe(201);
    const corpo = (await resposta.json()) as {
      data: { itens: { descontoItem: number; subtotal: number }[]; descontoVenda: number; valorFinal: number };
    };
    expect(corpo.data.itens[0]?.descontoItem).toBe(20);
    expect(corpo.data.itens[0]?.subtotal).toBe(180);
    expect(corpo.data.descontoVenda).toBe(18);
    expect(corpo.data.valorFinal).toBe(162);

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.3: descontoVenda como number puro continua funcionando via HTTP real (retrocompatibilidade)", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        descontoVenda: 25,
        pagamentos: [],
      }),
    });
    expect(resposta.status).toBe(201);
    const corpo = (await resposta.json()) as { data: { descontoVenda: number; valorFinal: number } };
    expect(corpo.data.descontoVenda).toBe(25);
    expect(corpo.data.valorFinal).toBe(75);

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.3: desconto de item percentual acima de 100% é rejeitado com 400", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [
          {
            produtoId: produto.produtoId,
            varianteId: produto.varianteId,
            tamanhoId: produto.tamanhoId,
            quantidade: 1,
            desconto: { tipo: "percentual", valor: 150 },
          },
        ],
        pagamentos: [],
      }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.3: valorFinal enviado no payload é rejeitado pelo whitelist global (nunca usado como autoridade)", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [],
        valorFinal: 1,
      }),
    });
    // `valorFinal` não é um campo declarado em `CriarVendaPdvDto` —
    // `forbidNonWhitelisted` já rejeita a requisição inteira (defesa mais
    // forte que apenas ignorar o campo).
    expect(resposta.status).toBe(400);

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.4: crédito válido com adquirente e parcelas configuradas → 201", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(300, 5);
    const adquirenteId = await criarAdquirenteViaHttp([{ modalidade: "credito", parcelas: 3, percentual: 5.19 }]);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId, parcelas: 3, valor: 300 }],
      }),
    });
    expect(resposta.status).toBe(201);
    const corpo = (await resposta.json()) as { data: { pagamentos: { modalidade: string; adquirenteId: string; parcelas: number }[] } };
    expect(corpo.data.pagamentos[0]?.modalidade).toBe("credito");
    expect(corpo.data.pagamentos[0]?.adquirenteId).toBe(adquirenteId);
    expect(corpo.data.pagamentos[0]?.parcelas).toBe(3);

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.4: crédito com parcela NÃO configurada → 400", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);
    const adquirenteId = await criarAdquirenteViaHttp([{ modalidade: "credito", parcelas: 1, percentual: 3.49 }]);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId, parcelas: 5, valor: 100 }],
      }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.4: débito com parcela diferente de 1 → 400", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);
    const adquirenteId = await criarAdquirenteViaHttp([{ modalidade: "debito", parcelas: 1, percentual: 1.99 }]);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId, parcelas: 2, valor: 100 }],
      }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.4: crédito sem adquirente → 400", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Crédito", modalidade: "credito", parcelas: 1, valor: 100 }],
      }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.4: adquirente inativa → 400", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);
    const adquirenteId = await criarAdquirenteViaHttp([{ modalidade: "debito", parcelas: 1, percentual: 1.99 }], false);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId, valor: 100 }],
      }),
    });
    const corpo = (await resposta.json()) as { code: string };
    expect(resposta.status).toBe(400);
    expect(corpo.code).toBe("VALIDATION_ERROR");

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.4: adquirente inexistente → 404", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Débito", modalidade: "debito", adquirenteId: "65f1a2b3c4d5e6f7a8b9c0d1", valor: 100 }],
      }),
    });
    expect(resposta.status).toBe(404);

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.4: dinheiro sem adquirente continua funcionando → 201", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", modalidade: "dinheiro", valor: 100 }],
      }),
    });
    expect(resposta.status).toBe(201);

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.4: payload legado (sem modalidade em nenhum pagamento) continua funcionando → 201", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      }),
    });
    expect(resposta.status).toBe(201);
    const corpo = (await resposta.json()) as { data: { pagamentos: { modalidade: string | null }[] } };
    expect(corpo.data.pagamentos[0]?.modalidade).toBeNull();

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.5: crédito com adquirente/parcelas configuradas → tarifaAplicada correta na resposta HTTP", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(300, 5);
    const adquirenteId = await criarAdquirenteViaHttp([{ modalidade: "credito", parcelas: 6, percentual: 5 }]);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Crédito", modalidade: "credito", adquirenteId, parcelas: 6, valor: 300 }],
      }),
    });
    expect(resposta.status).toBe(201);
    const corpo = (await resposta.json()) as {
      data: {
        valorPago: number;
        pagamentos: {
          modalidade: string;
          adquirenteId: string;
          parcelas: number;
          valor: number;
          tarifaAplicada: {
            adquirenteId: string;
            adquirenteNome: string;
            modalidade: string;
            parcelas: number;
            percentual: number;
            valorBruto: number;
            valorTarifa: number;
            valorLiquido: number;
          } | null;
        }[];
      };
    };
    const pagamento = corpo.data.pagamentos[0];
    expect(pagamento?.valor).toBe(300); // bruto — a tarifa nunca reduz o pagamento
    expect(corpo.data.valorPago).toBe(300);
    expect(pagamento?.tarifaAplicada).not.toBeNull();
    expect(pagamento?.tarifaAplicada?.adquirenteId).toBe(adquirenteId);
    expect(pagamento?.tarifaAplicada?.modalidade).toBe("credito");
    expect(pagamento?.tarifaAplicada?.parcelas).toBe(6);
    expect(pagamento?.tarifaAplicada?.percentual).toBe(5);
    expect(pagamento?.tarifaAplicada?.valorBruto).toBe(300);
    expect(pagamento?.tarifaAplicada?.valorTarifa).toBe(15);
    expect(pagamento?.tarifaAplicada?.valorLiquido).toBe(285);

    await fecharCaixaAbertoSeExistir();
  });

  it("Etapa 10.5: PIX/dinheiro continuam com tarifaAplicada null na resposta HTTP", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();
    await abrirCaixaViaPdv(vendedor.accessToken);
    const produto = await criarProdutoComEstoque(100, 5);

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/vendas`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "PIX", modalidade: "pix", valor: 100 }],
      }),
    });
    expect(resposta.status).toBe(201);
    const corpo = (await resposta.json()) as { data: { pagamentos: { tarifaAplicada: unknown }[] } };
    expect(corpo.data.pagamentos[0]?.tarifaAplicada).toBeNull();

    await fecharCaixaAbertoSeExistir();
  });

  it("GET /docs-json documenta POST /pdv/vendas com o security scheme Bearer", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(documento.paths["/api/v1/pdv/vendas"]?.["post"]).toBeTruthy();
  });
});
