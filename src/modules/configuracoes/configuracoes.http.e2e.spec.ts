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
import type { Sequencia } from "../sequencias/schemas/sequencia.schema.js";
import type { Configuracao, RemocaoPendente } from "./schemas/configuracao.schema.js";

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
    await connection.collection<Configuracao>("configuracoes").deleteMany({});
    await connection.collection("eventos_configuracao").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["vendedor", "usuario"] } });
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

      expect(Object.keys(corpo.data).sort()).toEqual(["atualizadoEm", "categorias", "cores", "formasPagamento", "loja", "mensagensWhatsapp", "tamanhos"].sort());
      expect(corpo.data["id"]).toBeUndefined(); // singleton nunca expõe id ao contrato
      expect(corpo.data["criadoEm"]).toBeUndefined();
      expect(corpo.data["__v"]).toBeUndefined();

      const loja = corpo.data["loja"] as Record<string, unknown>;
      expect(Object.keys(loja).sort()).toEqual(["email", "endereco", "logo", "nome", "telefone", "whatsapp"].sort());
      const enderecoResposta = loja["endereco"] as Record<string, unknown>;
      expect(Object.keys(enderecoResposta).sort()).toEqual(["bairro", "cep", "cidade", "complemento", "estado", "logradouro", "numero"].sort());
    });

    it("Fase 56.4.2 — com uma remoção pendente no documento, a resposta continua sem remocoesPendentes e sem os espelhos normalizados", async () => {
      await fetch(`${baseUrl}/api/v1/configuracoes`, { headers: jsonHeaders(adminAccessToken) }); // garante o singleton
      const pendencia: RemocaoPendente = { opId: `http-${Date.now()}`, lista: "cores", valor: "Cor HTTP Pendente", normalizado: "cor http pendente", posicao: 0, em: new Date() };
      await connection.collection<Configuracao>("configuracoes").updateOne({ _id: "global" }, { $push: { remocoesPendentes: pendencia } });
      try {
        const resposta = await fetch(`${baseUrl}/api/v1/configuracoes`, { headers: jsonHeaders(adminAccessToken) });
        expect(resposta.status).toBe(200);
        const texto = await resposta.text();
        const corpo = JSON.parse(texto) as { data: Record<string, unknown> };
        expect(Object.keys(corpo.data).sort()).toEqual(["atualizadoEm", "categorias", "cores", "formasPagamento", "loja", "mensagensWhatsapp", "tamanhos"].sort());
        expect(texto).not.toContain("remocoesPendentes");
        expect(texto).not.toContain(pendencia.opId);
        expect(texto).not.toContain("Normalizad");
      } finally {
        await connection.collection<Configuracao>("configuracoes").updateOne({ _id: "global" }, { $pull: { remocoesPendentes: { opId: pendencia.opId } } });
      }
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

  describe("auditoria via HTTP", () => {
    function subDoToken(token: string): string {
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { sub: string };
      return payload.sub;
    }

    it("PUT loja, POST e DELETE de lista gravam eventos_configuracao com o ADMIN autenticado como ator e sem alterar o contrato de resposta", async () => {
      const adminId = subDoToken(adminAccessToken);
      const valor = `Auditoria HTTP ${Date.now()}`;
      await connection.collection("eventos_configuracao").deleteMany({});

      const loja = await fetch(`${baseUrl}/api/v1/configuracoes/loja`, {
        method: "PUT",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify(lojaValida({ nome: "Loja Auditada HTTP" })),
      });
      expect(loja.status).toBe(200);
      const adicionar = await fetch(`${baseUrl}/api/v1/configuracoes/categorias`, {
        method: "POST",
        headers: jsonHeaders(adminAccessToken),
        body: JSON.stringify({ valor }),
      });
      expect(adicionar.status).toBe(201);
      const remover = await fetch(`${baseUrl}/api/v1/configuracoes/categorias/${encodeURIComponent(valor)}`, {
        method: "DELETE",
        headers: jsonHeaders(adminAccessToken),
      });
      expect(remover.status).toBe(200);
      const corpoRemover = (await remover.json()) as { data: Record<string, unknown> };
      expect(Object.keys(corpoRemover.data).sort()).toEqual(["atualizadoEm", "categorias", "cores", "formasPagamento", "loja", "mensagensWhatsapp", "tamanhos"].sort());

      const eventos = await connection.collection("eventos_configuracao").find({}).sort({ criadoEm: 1 }).toArray();
      expect(eventos.map((evento) => evento["tipo"])).toEqual([
        "configuracao.loja_atualizada",
        "configuracao.item_adicionado",
        "configuracao.item_removido",
      ]);
      expect(eventos.every((evento) => evento["usuarioId"] === adminId)).toBe(true);
      expect(eventos[1]!["detalhes"]).toEqual({ lista: "categorias", valor });
      expect(eventos[2]!["detalhes"]).toEqual({ lista: "categorias", valor });
    });

    it("requisição rejeitada (400/409/404) não grava evento", async () => {
      await connection.collection("eventos_configuracao").deleteMany({});
      const valor = `SemEventoHTTP ${Date.now()}`;
      await fetch(`${baseUrl}/api/v1/configuracoes/cores`, { method: "POST", headers: jsonHeaders(adminAccessToken), body: JSON.stringify({ valor }) });
      await connection.collection("eventos_configuracao").deleteMany({}); // descarta o evento do POST bem-sucedido acima

      const duplicado = await fetch(`${baseUrl}/api/v1/configuracoes/cores`, { method: "POST", headers: jsonHeaders(adminAccessToken), body: JSON.stringify({ valor }) });
      const vazio = await fetch(`${baseUrl}/api/v1/configuracoes/cores`, { method: "POST", headers: jsonHeaders(adminAccessToken), body: JSON.stringify({ valor: "" }) });
      const inexistente = await fetch(`${baseUrl}/api/v1/configuracoes/cores/${encodeURIComponent(`Inexistente-${Date.now()}`)}`, {
        method: "DELETE",
        headers: jsonHeaders(adminAccessToken),
      });
      const semToken = await fetch(`${baseUrl}/api/v1/configuracoes/cores`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ valor: "SemToken" }) });
      expect([duplicado.status, vazio.status, inexistente.status, semToken.status]).toEqual([409, 400, 404, 401]);

      expect(await connection.collection("eventos_configuracao").countDocuments({})).toBe(0);
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

  describe("Fase 22.8.9.10.7.3 — mensagens padrão de WhatsApp", () => {
    type Mensagem = { id: string; titulo: string; conteudo: string; atualizadoEm: string };
    const URL_MENSAGENS = () => `${baseUrl}/api/v1/configuracoes/whatsapp/mensagens-padrao`;
    const colecao = () => connection.collection<Configuracao>("configuracoes");

    async function obterMensagens(): Promise<Mensagem[]> {
      const resposta = await fetch(`${baseUrl}/api/v1/configuracoes`, { headers: jsonHeaders(adminAccessToken) });
      expect(resposta.status).toBe(200);
      return ((await resposta.json()) as { data: { mensagensWhatsapp: Mensagem[] } }).data.mensagensWhatsapp;
    }
    const criar = (corpo: unknown, token = adminAccessToken) =>
      fetch(URL_MENSAGENS(), { method: "POST", headers: jsonHeaders(token), body: JSON.stringify(corpo) });
    const editar = (id: string, corpo: unknown) =>
      fetch(`${URL_MENSAGENS()}/${id}`, { method: "PUT", headers: jsonHeaders(adminAccessToken), body: JSON.stringify(corpo) });
    const excluir = (id: string, token = adminAccessToken) => fetch(`${URL_MENSAGENS()}/${id}`, { method: "DELETE", headers: jsonHeaders(token) });

    /** Volta o documento ao estado "campo nunca inicializado" (documento legado). */
    async function resetarParaLegado(): Promise<void> {
      await fetch(`${baseUrl}/api/v1/configuracoes`, { headers: jsonHeaders(adminAccessToken) });
      await colecao().updateOne({ _id: "global" }, { $unset: { mensagensWhatsapp: "" } });
    }

    it("documento legado (sem o campo) recebe o conjunto inicial UMA vez, com ids UUID; leituras simultâneas não duplicam", async () => {
      await resetarParaLegado();
      await Promise.all(Array.from({ length: 5 }, () => fetch(`${baseUrl}/api/v1/configuracoes`, { headers: jsonHeaders(adminAccessToken) })));
      const mensagens = await obterMensagens();
      expect(mensagens.map((m) => m.titulo)).toEqual([
        "Saudação",
        "Agradecimento pela compra",
        "Pedido pronto para retirada",
        "Aviso de pagamento",
        "Aviso de pedido",
        "Atendimento personalizado",
      ]);
      for (const m of mensagens) {
        expect(Object.keys(m).sort()).toEqual(["atualizadoEm", "conteudo", "id", "titulo"]);
        expect(m.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(m.conteudo.toUpperCase()).not.toContain("SAIR");
      }
      expect(new Set(mensagens.map((m) => m.id)).size).toBe(6);
    });

    it("cria (201), edita (200) e exclui (200) com persistência; auditoria só com o id (nunca o texto)", async () => {
      await resetarParaLegado();
      await obterMensagens();
      await connection.collection("eventos_configuracao").deleteMany({});

      const criada = await criar({ titulo: "  Troca disponível  ", conteudo: "  Olá! A troca do seu produto já está disponível.  " });
      expect(criada.status).toBe(201);
      const nova = (await obterMensagens()).find((m) => m.titulo === "Troca disponível")!;
      expect(nova.conteudo).toBe("Olá! A troca do seu produto já está disponível.");

      const editada = await editar(nova.id, { titulo: "Troca liberada", conteudo: "Olá! Sua troca foi liberada.\nPode vir quando quiser." });
      expect(editada.status).toBe(200);
      const depois = (await obterMensagens()).find((m) => m.id === nova.id)!;
      expect(depois).toMatchObject({ titulo: "Troca liberada", conteudo: "Olá! Sua troca foi liberada.\nPode vir quando quiser." });
      expect((await obterMensagens()).length).toBe(7);

      expect((await excluir(nova.id)).status).toBe(200);
      expect((await obterMensagens()).some((m) => m.id === nova.id)).toBe(false);
      expect((await excluir(nova.id)).status).toBe(404);

      const eventos = await connection.collection("eventos_configuracao").find({}).sort({ criadoEm: 1 }).toArray();
      expect(eventos.map((e) => e["tipo"])).toEqual([
        "configuracao.mensagem_whatsapp_criada",
        "configuracao.mensagem_whatsapp_atualizada",
        "configuracao.mensagem_whatsapp_excluida",
      ]);
      expect(eventos.every((e) => JSON.stringify(e["detalhes"]) === JSON.stringify({ id: nova.id }))).toBe(true);
    });

    it("validação: vazio/espaços (400), longo demais (400), campo extra (400), id não-UUID (400), id inexistente (404)", async () => {
      await obterMensagens();
      const respostas = await Promise.all([
        criar({ titulo: "   ", conteudo: "texto" }),
        criar({ titulo: "Título", conteudo: "   " }),
        criar({ titulo: "x".repeat(61), conteudo: "texto" }),
        criar({ titulo: "Título", conteudo: "x".repeat(1001) }),
        criar({ titulo: "Título", conteudo: "texto", telefone: "11999990000" }),
        criar({ titulo: "Sem conteúdo" }),
        editar("nao-e-uuid", { titulo: "A", conteudo: "B" }),
        editar("0b0a4a3e-6a7d-4f0e-9c1a-2d3e4f5a6b7c", { titulo: "A", conteudo: "B" }),
      ]);
      expect(respostas.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400, 400, 404]);
    });

    it("título repetido (sem diferenciar maiúsculas) → 409, na criação e na edição; editar mantendo o próprio título é permitido", async () => {
      await resetarParaLegado();
      const [primeira, segunda] = await obterMensagens();
      expect((await criar({ titulo: primeira!.titulo.toUpperCase(), conteudo: "outro texto" })).status).toBe(409);
      expect((await editar(segunda!.id, { titulo: primeira!.titulo.toLowerCase(), conteudo: "x" })).status).toBe(409);
      expect((await editar(primeira!.id, { titulo: primeira!.titulo, conteudo: "Texto novo." })).status).toBe(200);
    });

    it("criações simultâneas com o MESMO título → exatamente uma (201), as demais 409", async () => {
      await obterMensagens();
      const titulo = `Simultânea ${Date.now()}`;
      const respostas = await Promise.all(Array.from({ length: 8 }, () => criar({ titulo, conteudo: "texto" })));
      expect(respostas.filter((r) => r.status === 201)).toHaveLength(1);
      expect(respostas.filter((r) => r.status === 409)).toHaveLength(7);
      expect((await obterMensagens()).filter((m) => m.titulo === titulo)).toHaveLength(1);
    });

    it("limite de 30 mensagens → 400; lista vazia (todas excluídas) continua vazia (nunca é re-semeada)", async () => {
      await resetarParaLegado();
      const iniciais = await obterMensagens();
      for (let i = iniciais.length; i < 30; i++) expect((await criar({ titulo: `Limite ${i}`, conteudo: "texto" })).status).toBe(201);
      expect((await criar({ titulo: "Uma a mais", conteudo: "texto" })).status).toBe(400);
      for (const m of await obterMensagens()) expect((await excluir(m.id)).status).toBe(200);
      expect(await obterMensagens()).toEqual([]);
      expect(await obterMensagens()).toEqual([]);
    });

    it("sem token → 401; token do PDV (vendedor) → 401; nada é gravado", async () => {
      await obterMensagens();
      const antes = (await obterMensagens()).length;
      const tokenVendedor = await criarELogarVendedorPdv();
      expect((await criar({ titulo: "Sem token", conteudo: "x" }, "")).status).toBe(401);
      expect((await criar({ titulo: "Vendedor", conteudo: "x" }, tokenVendedor)).status).toBe(401);
      expect((await obterMensagens()).length).toBe(antes);
    });
  });
});
