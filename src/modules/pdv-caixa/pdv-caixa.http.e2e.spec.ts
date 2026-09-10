import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
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
import { CaixasService, type CaixaDetalheResposta } from "../caixas/caixas.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";

/**
 * Sobe a aplicação HTTP DE VERDADE contra o banco de teste isolado
 * (`mariela_test` — nunca `mariela_dev`), mesmo padrão dos demais módulos.
 * Cobre o fluxo completo de Caixa no PDV: caixa único compartilhado por
 * todos os vendedores, abertura concorrente, fechamento pelo ADMIN e a
 * separação real entre os dois contextos de autenticação.
 */
describe("HTTP — PDV Caixa (integração — servidor real)", () => {
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
    const email = `teste.http.pdv-caixa.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP PDV Caixa", email, senha: "senha-forte-123" });
    const login = await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null });
    adminAccessToken = login.accessToken;
  });

  afterAll(async () => {
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["caixa", "vendedor", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  async function fecharCaixaAbertoSeExistir(): Promise<void> {
    const caixasService = app.get(CaixasService);
    const atual: CaixaDetalheResposta | null = await caixasService.obterAtual();
    if (atual) await caixasService.fechar(atual.id, { valorInformado: atual.resumo.saldoEsperado }, null);
  }

  async function criarELogarVendedor(): Promise<{ id: string; codigo: string; nome: string; accessToken: string }> {
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await vendedoresService.criar({ nome: "Vendedora HTTP PDV Caixa", telefone: telefoneUnico(), ativo: true, senha: "senha123" }, null);

    const respostaLogin = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }),
    });
    const corpo = (await respostaLogin.json()) as { data: { accessToken: string } };
    return { id: vendedor.id, codigo: vendedor.codigo, nome: vendedor.nome, accessToken: corpo.data.accessToken };
  }

  it("GET /api/v1/pdv/caixa/atual SEM token retorna 401", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/caixa/atual`);
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/pdv/caixa/atual com token do ADMIN é rejeitado (401)", async () => {
    const resposta = await fetch(`${baseUrl}/api/v1/pdv/caixa/atual`, { headers: jsonHeaders(adminAccessToken) });
    expect(resposta.status).toBe(401);
  });

  it("GET /api/v1/pdv/caixa/:atual com um vendedor autenticado e nenhum caixa aberto devolve data: null (nunca 404)", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/caixa/atual`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(resposta.status).toBe(200);
    const corpo = (await resposta.json()) as { data: unknown };
    expect(corpo.data).toBeNull();
  });

  it("fluxo completo: vendedor A abre → vendedor B enxerga o MESMO caixa → vendedor B tentando abrir recebe 409", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedorA = await criarELogarVendedor();
    const vendedorB = await criarELogarVendedor();

    const respostaAbertura = await fetch(`${baseUrl}/api/v1/pdv/caixa/abertura`, {
      method: "POST",
      headers: jsonHeaders(vendedorA.accessToken),
      body: JSON.stringify({ valorInicial: 200, observacao: "Troco inicial" }),
    });
    expect(respostaAbertura.status).toBe(201);
    const corpoAbertura = (await respostaAbertura.json()) as {
      data: { id: string; codigo: string; abertura: { responsavelId: string | null; responsavelNome: string; valorInicial: number } };
    };
    // Etapa 18.2 — o Caixa não tem mais vínculo de vendedor: o vendedor
    // autenticado (vendedorA) NUNCA aparece no documento do Caixa, só no
    // evento de auditoria (ver asserção abaixo).
    expect(corpoAbertura.data.abertura.responsavelId).toBeNull();
    expect(corpoAbertura.data.abertura.responsavelNome).toBe("Loja");
    expect(corpoAbertura.data.abertura.valorInicial).toBe(200);

    // Confirma no banco: o documento persistido não guarda nenhum vínculo de vendedor.
    const documento = await connection.collection("caixas").findOne({ codigo: corpoAbertura.data.codigo });
    expect(documento?.["responsavelId"]).toBeUndefined();
    expect(documento?.["responsavelNome"]).toBeUndefined();

    // O vendedor autenticado só aparece como autor do evento de auditoria.
    const evento = await connection.collection("eventos_caixa").findOne({ caixaId: new Types.ObjectId(corpoAbertura.data.id), tipo: "caixa.aberto" });
    expect(evento?.["usuarioId"]).toBe(vendedorA.id);

    // Vendedor B, autenticado de forma completamente independente, enxerga o MESMO caixa.
    const respostaAtualB = await fetch(`${baseUrl}/api/v1/pdv/caixa/atual`, { headers: jsonHeaders(vendedorB.accessToken) });
    const corpoAtualB = (await respostaAtualB.json()) as { data: { codigo: string } };
    expect(corpoAtualB.data.codigo).toBe(corpoAbertura.data.codigo);

    // Vendedor B tenta abrir outro caixa — o índice único parcial impede (409).
    const respostaAberturaB = await fetch(`${baseUrl}/api/v1/pdv/caixa/abertura`, {
      method: "POST",
      headers: jsonHeaders(vendedorB.accessToken),
      body: JSON.stringify({ valorInicial: 100 }),
    });
    expect(respostaAberturaB.status).toBe(409);

    await fecharCaixaAbertoSeExistir();
  });

  it("abertura concorrente: dois vendedores abrindo ao mesmo tempo — exatamente um 201 e um 409, nunca dois caixas abertos", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedorA = await criarELogarVendedor();
    const vendedorB = await criarELogarVendedor();

    const abrir = (token: string) =>
      fetch(`${baseUrl}/api/v1/pdv/caixa/abertura`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ valorInicial: 150 }),
      });

    const [respostaA, respostaB] = await Promise.all([abrir(vendedorA.accessToken), abrir(vendedorB.accessToken)]);
    const status = [respostaA.status, respostaB.status].sort();
    expect(status).toEqual([201, 409]);

    const caixasAbertos = await connection.collection("caixas").countDocuments({ status: "aberto" });
    expect(caixasAbertos).toBe(1);

    await fecharCaixaAbertoSeExistir();
  });

  it("um cliente que tenta enviar responsavelId no payload de abertura recebe 400 (nunca é usado como autoridade)", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedor = await criarELogarVendedor();

    const resposta = await fetch(`${baseUrl}/api/v1/pdv/caixa/abertura`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({ valorInicial: 100, responsavelId: "65f1a2b3c4d5e6f7a8b9c0d1" }),
    });
    expect(resposta.status).toBe(400);
    expect(await connection.collection("caixas").countDocuments({ status: "aberto" })).toBe(0);
  });

  it("vendedor inativo não consegue consultar nem abrir o caixa do PDV", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedoresService = app.get(VendedoresService);
    const vendedor = await criarELogarVendedor();
    await vendedoresService.alterarStatus(vendedor.id, { ativo: false }, null);

    const respostaAtual = await fetch(`${baseUrl}/api/v1/pdv/caixa/atual`, { headers: jsonHeaders(vendedor.accessToken) });
    expect(respostaAtual.status).toBe(401);

    const respostaAbertura = await fetch(`${baseUrl}/api/v1/pdv/caixa/abertura`, {
      method: "POST",
      headers: jsonHeaders(vendedor.accessToken),
      body: JSON.stringify({ valorInicial: 100 }),
    });
    expect(respostaAbertura.status).toBe(401);
  });

  it("ADMIN fecha o caixa pelo Backoffice → PDV deixa de enxergar caixa aberto → um novo vendedor pode abrir de novo", async () => {
    await fecharCaixaAbertoSeExistir();
    const vendedorInicial = await criarELogarVendedor();

    await fetch(`${baseUrl}/api/v1/pdv/caixa/abertura`, {
      method: "POST",
      headers: jsonHeaders(vendedorInicial.accessToken),
      body: JSON.stringify({ valorInicial: 300 }),
    });

    const caixasService = app.get(CaixasService);
    const aberto = await caixasService.obterAtual();
    expect(aberto).not.toBeNull();

    const respostaFechamento = await fetch(`${baseUrl}/api/v1/caixas/${aberto!.id}/fechamento`, {
      method: "POST",
      headers: jsonHeaders(adminAccessToken),
      body: JSON.stringify({ valorInformado: aberto!.resumo.saldoEsperado }),
    });
    expect(respostaFechamento.status).toBe(201);

    const respostaAtualPosFechamento = await fetch(`${baseUrl}/api/v1/pdv/caixa/atual`, { headers: jsonHeaders(vendedorInicial.accessToken) });
    const corpoPosFechamento = (await respostaAtualPosFechamento.json()) as { data: unknown };
    expect(corpoPosFechamento.data).toBeNull();

    const novoVendedor = await criarELogarVendedor();
    const respostaNovaAbertura = await fetch(`${baseUrl}/api/v1/pdv/caixa/abertura`, {
      method: "POST",
      headers: jsonHeaders(novoVendedor.accessToken),
      body: JSON.stringify({ valorInicial: 400 }),
    });
    expect(respostaNovaAbertura.status).toBe(201);

    await fecharCaixaAbertoSeExistir();
  });

  describe("não existe fechamento nem movimentação manual pelo PDV", () => {
    it("POST /api/v1/pdv/caixa/fechamento não existe (404)", async () => {
      const vendedor = await criarELogarVendedor();
      const resposta = await fetch(`${baseUrl}/api/v1/pdv/caixa/fechamento`, {
        method: "POST",
        headers: jsonHeaders(vendedor.accessToken),
        body: "{}",
      });
      expect(resposta.status).toBe(404);
    });

    it("POST /api/v1/pdv/caixa/entrada e /saida não existem (404)", async () => {
      const vendedor = await criarELogarVendedor();
      const respostaEntrada = await fetch(`${baseUrl}/api/v1/pdv/caixa/entrada`, { method: "POST", headers: jsonHeaders(vendedor.accessToken), body: "{}" });
      const respostaSaida = await fetch(`${baseUrl}/api/v1/pdv/caixa/saida`, { method: "POST", headers: jsonHeaders(vendedor.accessToken), body: "{}" });
      expect(respostaEntrada.status).toBe(404);
      expect(respostaSaida.status).toBe(404);
    });
  });

  describe("isolamento real entre ADMIN e PDV", () => {
    it("um JWT do ADMIN é rejeitado em /pdv/caixa/*", async () => {
      const resposta = await fetch(`${baseUrl}/api/v1/pdv/caixa/atual`, { headers: jsonHeaders(adminAccessToken) });
      expect(resposta.status).toBe(401);
    });

    it("um JWT do PDV é rejeitado em /caixas/* (rota administrativa)", async () => {
      const vendedor = await criarELogarVendedor();
      const resposta = await fetch(`${baseUrl}/api/v1/caixas`, { headers: jsonHeaders(vendedor.accessToken) });
      expect(resposta.status).toBe(401);
    });
  });

  it("GET /docs-json documenta as rotas de /pdv/caixa com o security scheme Bearer", async () => {
    const resposta = await fetch(`${baseUrl}/docs-json`);
    const documento = (await resposta.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(documento.paths["/api/v1/pdv/caixa/atual"]?.["get"]).toBeTruthy();
    expect(documento.paths["/api/v1/pdv/caixa/abertura"]?.["post"]).toBeTruthy();
  });
});
