import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { ValidationPipe } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import type { AddressInfo } from "node:net";
import type { Connection } from "mongoose";
import { AppModule } from "../../../app.module.js";
import { HttpExceptionFilter } from "../../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../../common/pipes/validation-exception-factory.js";
import type { WhatsappConfig } from "../../../config/configuration.js";
import { MONGODB_URI_TESTE } from "../../../test-utils/mongo-teste.util.js";
import { AuthService } from "../../auth/auth.service.js";
import { ClientesService } from "../../clientes/clientes.service.js";
import type { Sequencia } from "../../sequencias/schemas/sequencia.schema.js";
import type { FetchMeta } from "../providers/meta/cliente-http-meta.js";
import { ProvedorEnvioDesativado } from "../providers/provedor-envio-desativado.js";
import { PROVEDOR_ENVIO_WHATSAPP, type ProvedorEnvioWhatsapp } from "../providers/provedor-envio-whatsapp.interface.js";
import { criarProvedorEnvioWhatsapp } from "../providers/selecionar-provedor-envio.js";

/**
 * Fase 22.8.9.10.4 — HTTP real (guards, pipes, filtro, prefixo) com o ADAPTADOR META sobre uma Graph API FALSA
 * (`fetch` injetado), e com o provedor PADRÃO (desativado) resolvido pelo próprio `AppModule`. Nenhuma chamada à Meta.
 */
const TOKEN = "TOKEN-FICTICIO-DE-TESTE";
const CONFIG: WhatsappConfig = {
  ownerPhone: "",
  evolution: { apiUrl: "", apiKey: "", instanceName: "x", timeoutMs: 10_000 },
  provedorEnvio: "meta-cloud-api",
  meta: { graphApiVersion: "v26.0", phoneNumberId: "100000000000001", businessAccountId: "200000000000002", accessToken: TOKEN, timeoutMs: 1_000 },
};

const json = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

async function subirApp(provedor: ProvedorEnvioWhatsapp | null) {
  process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (provedor) builder.overrideProvider(PROVEDOR_ENVIO_WHATSAPP).useValue(provedor);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });
  await app.init();
  await app.listen(0);
  const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const connection = app.get<Connection>(getConnectionToken());
  await connection.model("MensagemWhatsapp").init();
  await connection.model("BloqueioWhatsapp").init();
  const auth = app.get(AuthService);
  const email = `teste.http.whatsapp.meta.${Date.now()}.${randomUUID().slice(0, 8)}@mariela.dev`;
  await auth.criarAdminSeed({ nome: "HTTP WhatsApp Meta", email, senha: "senha-forte-123" });
  const token = (await auth.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null })).accessToken;
  return { app, baseUrl, connection, token };
}

async function limpar(connection: Connection) {
  await connection.collection("mensagens_whatsapp").deleteMany({});
  await connection.collection("whatsapp_bloqueios").deleteMany({});
  await connection.collection("clientes").deleteMany({});
  await connection.collection("eventos_cliente").deleteMany({});
  await connection.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["cliente", "usuario"] } });
  await connection.collection("usuarios").deleteMany({});
  await connection.collection("refresh_tokens").deleteMany({});
  await connection.collection("eventos_auth").deleteMany({});
}

describe("HTTP — envio por template com o adaptador Meta (Graph API falsa)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let token: string;
  let clientes: ClientesService;
  let contador = 0;
  const chamadas: { url: string; metodo: string; corpo: string | null }[] = [];
  let respostaEnvio: () => Response;
  const aceite = () =>
    json(200, { messaging_product: "whatsapp", contacts: [{ input: "x", wa_id: "5589000000000" }], messages: [{ id: `wamid.HTTP${chamadas.length}`, message_status: "accepted" }] });

  const fetchFalso: FetchMeta = async (url, init) => {
    chamadas.push({ url, metodo: init.method ?? "GET", corpo: (init.body as string | undefined) ?? null });
    if (init.method === "GET") {
      return json(200, {
        data: [{ name: "mariela_aniversario_v1", language: "pt_BR", status: "APPROVED", category: "MARKETING", id: "1", components: [{ type: "BODY", text: "Olá, {{1}}!" }] }],
      });
    }
    return respostaEnvio();
  };

  const url = (caminho: string) => `${baseUrl}/api/v1/integracoes/whatsapp${caminho}`;
  const post = (caminho: string, corpo: unknown) =>
    fetch(url(caminho), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(corpo) });
  const novoCliente = () => clientes.criar({ nome: "Marta Teste HTTP", telefone: `859${String(++contador).padStart(8, "0")}` }, null);
  const corpoEnvio = (clienteId: string) => ({ idempotencyKey: randomUUID(), destinatario: { tipo: "CLIENTE", id: clienteId }, template: "aniversario_v1" });

  beforeAll(async () => {
    ({ app, baseUrl, connection, token } = await subirApp(criarProvedorEnvioWhatsapp(CONFIG, fetchFalso)));
    clientes = app.get(ClientesService);
  }, 30_000);

  beforeEach(async () => {
    await connection.collection("mensagens_whatsapp").deleteMany({});
    chamadas.length = 0;
    respostaEnvio = aceite;
    app.get<{ storage: Map<string, unknown> }>(ThrottlerStorage).storage.clear();
  });

  afterAll(async () => {
    await limpar(connection);
    await app.close();
  });

  it("GET /templates: aprovação confirmada na Meta (APROVADO)", async () => {
    const r = await fetch(url("/templates"), { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { chave: string; estadoAprovacao: string }[] };
    expect(corpo.data.find((t) => t.chave === "aniversario_v1")?.estadoAprovacao).toBe("APROVADO");
  });

  it("POST /envios: 201 aceita; repetição 200 sem novo POST à Meta; resposta sem telefone, token, wamid nem texto", async () => {
    const c = await novoCliente();
    const corpo = corpoEnvio(c.id);
    const r1 = await post("/envios", corpo);
    expect(r1.status).toBe(201);
    const t1 = await r1.text();
    const b1 = JSON.parse(t1) as { data: { id: string; estado: string; destinatario: { telefoneMascarado: string } } };
    expect(b1.data.estado).toBe("aceita");
    expect(b1.data.destinatario.telefoneMascarado).toContain("****");
    for (const proibido of [c.telefone, TOKEN, "wamid", "Marta"]) expect(t1).not.toContain(proibido);

    const r2 = await post("/envios", corpo);
    expect(r2.status).toBe(200);
    expect(chamadas.filter((x) => x.metodo === "POST")).toHaveLength(1);
    // O POST à Meta usou o telefone do CADASTRO (não veio do corpo HTTP).
    expect(JSON.parse(chamadas.find((x) => x.metodo === "POST")!.corpo!).to).toBe(`+55${c.telefone}`);
  });

  it("recusa da Meta (131026) → 201 com falha SEM_WHATSAPP; o texto técnico da Meta não chega ao Backoffice", async () => {
    const c = await novoCliente();
    respostaEnvio = () => json(400, { error: { code: 131026, message: "Message undeliverable DETALHE-TECNICO-META", fbtrace_id: "abc" } });
    const r = await post("/envios", corpoEnvio(c.id));
    expect(r.status).toBe(201);
    const t = await r.text();
    const b = JSON.parse(t) as { data: { estado: string; erro: { codigo: string; mensagem: string } } };
    expect(b.data.estado).toBe("falha");
    expect(b.data.erro.codigo).toBe("SEM_WHATSAPP");
    expect(t).not.toContain("DETALHE-TECNICO-META");
    expect(t).not.toContain("131026");
  });

  it("timeout na Meta → 201 indeterminada; nunca reenviada automaticamente", async () => {
    const c = await novoCliente();
    respostaEnvio = () => {
      throw new DOMException("aborted", "AbortError");
    };
    const corpo = corpoEnvio(c.id);
    const r = await post("/envios", corpo);
    expect(((await r.json()) as { data: { estado: string } }).data.estado).toBe("indeterminada");
    await post("/envios", corpo);
    expect(chamadas.filter((x) => x.metodo === "POST")).toHaveLength(1);
  });

  it("o Backoffice não escolhe provedor, credencial, telefone, texto nem parâmetros: campos extras → 400, nada enviado", async () => {
    const c = await novoCliente();
    for (const extra of [{ provedor: "meta-cloud-api" }, { accessToken: "x" }, { telefone: "85999990000" }, { mensagem: "texto" }, { parametros: ["Outro"] }]) {
      expect((await post("/envios", { ...corpoEnvio(c.id), ...extra })).status).toBe(400);
    }
    expect(chamadas).toHaveLength(0);
  });
});

describe("HTTP — provedor PADRÃO do AppModule (sem configuração da Meta)", () => {
  const anterior = process.env["WHATSAPP_PROVEDOR_ENVIO"];
  let ctx: Awaited<ReturnType<typeof subirApp>>;

  beforeAll(async () => {
    // Determinístico mesmo com variáveis locais: força "ausente" para esta suíte.
    process.env["WHATSAPP_PROVEDOR_ENVIO"] = "";
    ctx = await subirApp(null);
  }, 30_000);

  afterAll(async () => {
    if (anterior === undefined) delete process.env["WHATSAPP_PROVEDOR_ENVIO"];
    else process.env["WHATSAPP_PROVEDOR_ENVIO"] = anterior;
    await limpar(ctx.connection);
    await ctx.app.close();
  });

  it("o AppModule resolve o provedor DESATIVADO e POST /envios responde 503 sem gravar", async () => {
    expect(ctx.app.get(PROVEDOR_ENVIO_WHATSAPP)).toBeInstanceOf(ProvedorEnvioDesativado);
    const cliente = await ctx.app.get(ClientesService).criar({ nome: "Padrão Desativado", telefone: `889${String(Date.now()).slice(-8)}` }, null);
    const r = await fetch(`${ctx.baseUrl}/api/v1/integracoes/whatsapp/envios`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({ idempotencyKey: randomUUID(), destinatario: { tipo: "CLIENTE", id: cliente.id }, template: "aniversario_v1" }),
    });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe("WHATSAPP_NOT_CONFIGURED");
    expect(await ctx.connection.collection("mensagens_whatsapp").countDocuments({})).toBe(0);
  });
});
