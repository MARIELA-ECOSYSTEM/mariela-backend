import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { Logger, ValidationPipe } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
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
import { MONGODB_URI_TESTE } from "../../../test-utils/mongo-teste.util.js";
import { AuthService } from "../../auth/auth.service.js";
import { ClientesService } from "../../clientes/clientes.service.js";
import type { Sequencia } from "../../sequencias/schemas/sequencia.schema.js";
import {
  PROVEDOR_ENVIO_WHATSAPP,
  type EnviarTextoWhatsappInput,
  type InfoTemplateProvedorWhatsapp,
  type ProvedorEnvioWhatsapp,
  type ResultadoEnvioProvedorWhatsapp,
} from "../providers/provedor-envio-whatsapp.interface.js";
import { CONFIG_WEBHOOK_WHATSAPP } from "../webhook/configuracao-webhook-meta.js";
import { registrarCorpoBrutoWebhookWhatsapp } from "../webhook/corpo-bruto-webhook.js";

/**
 * Fase 22.8.9.10.7.4 — texto livre por HTTP REAL (AppModule inteiro, guards, pipes, filtro, prefixo e o MESMO corpo
 * bruto do webhook do `main.ts`). A janela é aberta por uma notificação "da Meta" assinada aqui com App Secret
 * FICTÍCIO; o provedor de envio é um dublê. Nenhuma chamada à Meta, nenhuma credencial real.
 */
const SEGREDO = "SEGREDO-FICTICIO-DE-TESTE-WEBHOOK";
const PHONE_ID = "100000000000001";
const TEXTO = "Olá! Seu pedido está pronto para retirada. TEXTO-HTTP-PRIVADO";

class ProvedorEnvioFalso implements ProvedorEnvioWhatsapp {
  readonly nome = "falso";
  textos: EnviarTextoWhatsappInput[] = [];
  configurado(): boolean {
    return true;
  }
  async enviarTemplate(): Promise<ResultadoEnvioProvedorWhatsapp> {
    throw new Error("template não é usado nesta suíte");
  }
  async enviarTexto(i: EnviarTextoWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp> {
    this.textos.push(i);
    return { resultado: "aceita", wamid: `wamid.HTTPTX${i.referenciaInterna}`, waId: i.telefoneE164.slice(1) };
  }
  async consultarTemplate(nomeMeta: string, idioma: string): Promise<InfoTemplateProvedorWhatsapp | null> {
    return { nomeMeta, idioma, status: "APPROVED", categoria: "MARKETING", quantidadeParametros: 1 };
  }
}

describe("HTTP — texto livre na janela de 24 h (servidor real, webhook assinado, provedor dublê)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let token: string;
  let provedor: ProvedorEnvioFalso;
  let clientes: ClientesService;
  let contador = 0;
  let logs: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];

  const h = (comToken: string | null = token) => ({ "content-type": "application/json", ...(comToken ? { authorization: `Bearer ${comToken}` } : {}) });
  const url = (caminho: string) => `${baseUrl}/api/v1/integracoes/whatsapp${caminho}`;
  const post = (caminho: string, corpo: unknown, comToken: string | null = token) =>
    fetch(url(caminho), { method: "POST", headers: h(comToken), body: JSON.stringify(corpo) });
  const elegibilidade = async (clienteId: string) =>
    ((await (await fetch(url(`/clientes/${clienteId}/texto-livre`), { headers: h() })).json()) as { data: { permitido: boolean; motivo: string | null; janelaExpiraEm: string | null } })
      .data;
  const novoCliente = async () => {
    const telefone = `869${String(++contador).padStart(8, "0")}`;
    const c = await clientes.criar({ nome: "Cliente HTTP Texto", telefone }, null);
    return { id: String(c._id), telefone };
  };
  const corpoTexto = (clienteId: string, extra: Record<string, unknown> = {}) => ({
    idempotencyKey: randomUUID(),
    destinatario: { tipo: "CLIENTE", id: clienteId },
    texto: TEXTO,
    ...extra,
  });

  /** Notificação "da Meta": o cliente escreveu há 1 minuto. */
  const webhookMensagem = (telefone: string, assinatura: "valida" | "invalida" = "valida") => {
    const corpo = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "200000000000002",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550000000", phone_number_id: PHONE_ID },
                contacts: [{ wa_id: `55${telefone}`, profile: { name: "NOME-DO-PERFIL" } }],
                messages: [
                  {
                    from: `55${telefone}`,
                    id: `wamid.HTTPIN${randomUUID().replace(/-/g, "")}`,
                    timestamp: String(Math.floor(Date.now() / 1000) - 60),
                    type: "text",
                    text: { body: "MENSAGEM-DO-CLIENTE-PRIVADA" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const segredo = assinatura === "valida" ? SEGREDO : "OUTRO-SEGREDO-QUALQUER-1234";
    return fetch(`${baseUrl}/api/v1/integracoes/whatsapp/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", segredo).update(corpo).digest("hex")}` },
      body: corpo,
    });
  };

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    provedor = new ProvedorEnvioFalso();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PROVEDOR_ENVIO_WHATSAPP)
      .useValue(provedor)
      .overrideProvider(CONFIG_WEBHOOK_WHATSAPP)
      .useValue({ verifyToken: "VERIFY-TOKEN-FICTICIO-DE-TESTE", appSecret: SEGREDO, phoneNumberId: PHONE_ID })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });
    registrarCorpoBrutoWebhookWhatsapp(app, "api/v1");
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    connection = app.get(getConnectionToken());
    await connection.model("MensagemWhatsapp").init();
    await connection.model("JanelaWhatsapp").init();
    clientes = app.get(ClientesService);

    const auth = app.get(AuthService);
    const email = `teste.http.whatsapp.texto.${Date.now()}@mariela.dev`;
    await auth.criarAdminSeed({ nome: "HTTP WhatsApp Texto", email, senha: "senha-forte-123" });
    token = (await auth.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null })).accessToken;
  }, 30_000);

  beforeEach(async () => {
    await connection.collection("mensagens_whatsapp").deleteMany({});
    await connection.collection("whatsapp_bloqueios").deleteMany({});
    await connection.collection("whatsapp_janelas").deleteMany({});
    provedor.textos = [];
    app.get<{ storage: Map<string, unknown> }>(ThrottlerStorage).storage.clear();
    logs = [];
    spies = (["log", "warn", "error", "debug", "verbose"] as const).map((nivel) =>
      spyOn(Logger.prototype, nivel).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      }),
    );
  });

  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  afterAll(async () => {
    await connection.collection("mensagens_whatsapp").deleteMany({});
    await connection.collection("whatsapp_bloqueios").deleteMany({});
    await connection.collection("whatsapp_janelas").deleteMany({});
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["cliente", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
  });

  it("autenticação: sem token, token inválido ou papel não-ADMIN → 401; nada enviado", async () => {
    const c = await novoCliente();
    const naoAdmin = await app.get(JwtService).signAsync({ sub: "x", codigo: "VEN-0001", role: "VENDEDOR" });
    for (const t of [null, "token-invalido", naoAdmin]) {
      expect((await fetch(url(`/clientes/${c.id}/texto-livre`), { headers: h(t) })).status).toBe(401);
      expect((await post("/envios/texto", corpoTexto(c.id), t)).status).toBe(401);
    }
    expect(provedor.textos).toHaveLength(0);
  });

  it("contrato: telefone, waId, janela ou credencial no corpo (mesmo aninhado), texto ausente/vazio/longo, chave inválida → 400", async () => {
    const c = await novoCliente();
    await webhookMensagem(c.telefone);
    const invalidos = [
      corpoTexto(c.id, { telefone: "84999990000" }),
      corpoTexto(c.id, { waId: "5584999990000" }),
      corpoTexto(c.id, { janelaAbertaAte: "2099-01-01T00:00:00Z" }),
      corpoTexto(c.id, { ultimaMensagemRecebidaEm: new Date().toISOString() }),
      corpoTexto(c.id, { accessToken: "TOKEN-QUALQUER" }),
      { ...corpoTexto(c.id), destinatario: { tipo: "CLIENTE", id: c.id, telefone: "84999990000" } },
      { ...corpoTexto(c.id), destinatario: { tipo: "TELEFONE", id: "84999990000" } },
      corpoTexto(c.id, { texto: undefined }),
      corpoTexto(c.id, { texto: "" }),
      corpoTexto(c.id, { texto: "   " }),
      corpoTexto(c.id, { texto: 123 }),
      corpoTexto(c.id, { texto: "a".repeat(4097) }),
      corpoTexto(c.id, { idempotencyKey: "nao-e-uuid" }),
    ];
    for (const corpo of invalidos) {
      // O limite de envio (10/10 s) continua ativo; é zerado aqui só para caber os 13 casos independentes.
      app.get<{ storage: Map<string, unknown> }>(ThrottlerStorage).storage.clear();
      const r = await post("/envios/texto", corpo);
      expect(r.status).toBe(400);
    }
    expect(provedor.textos).toHaveLength(0);
    expect(await connection.collection("mensagens_whatsapp").countDocuments()).toBe(0);
  });

  it("fluxo completo: sem janela → 422; webhook assinado abre a janela; 201 envio; 200 repetição; histórico; nada sensível em log", async () => {
    const c = await novoCliente();
    expect(await elegibilidade(c.id)).toMatchObject({ permitido: false, motivo: "SEM_MENSAGEM_RECEBIDA" });
    const fechada = await post("/envios/texto", corpoTexto(c.id));
    expect(fechada.status).toBe(422);
    expect(((await fechada.json()) as { code: string }).code).toBe("WHATSAPP_JANELA_FECHADA");

    expect((await webhookMensagem(c.telefone)).status).toBe(200);
    const e = await elegibilidade(c.id);
    expect(e).toMatchObject({ permitido: true, motivo: null });
    expect(new Date(e.janelaExpiraEm!).getTime()).toBeGreaterThan(Date.now());

    const corpo = corpoTexto(c.id);
    const r1 = await post("/envios/texto", corpo);
    expect(r1.status).toBe(201);
    const b1 = (await r1.json()) as { data: { id: string; tipo: string; estado: string; texto: string; template: unknown } };
    expect(b1.data).toMatchObject({ tipo: "TEXTO", estado: "aceita", texto: TEXTO, template: null });
    expect(JSON.stringify(b1)).not.toContain(c.telefone);

    const r2 = await post("/envios/texto", corpo);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { data: { id: string } }).data.id).toBe(b1.data.id);
    const r3 = await post("/envios/texto", { ...corpo, texto: "Outro texto" });
    expect(r3.status).toBe(409);

    expect(provedor.textos).toEqual([{ telefoneE164: `+55${c.telefone}`, texto: TEXTO, referenciaInterna: b1.data.id }]);

    const lista = (await (await fetch(url(`/mensagens?clienteId=${c.id}`), { headers: h() })).json()) as { data: { id: string; tipo: string; texto: string }[] };
    expect(lista.data).toEqual([expect.objectContaining({ id: b1.data.id, tipo: "TEXTO", texto: TEXTO })]);

    const tudo = logs.join("\n");
    for (const proibido of ["MENSAGEM-DO-CLIENTE-PRIVADA", "TEXTO-HTTP-PRIVADO", "NOME-DO-PERFIL", c.telefone, SEGREDO]) expect(tudo).not.toContain(proibido);
  });

  it("webhook com assinatura INVÁLIDA não abre janela (401) e o envio segue recusado", async () => {
    const c = await novoCliente();
    expect((await webhookMensagem(c.telefone, "invalida")).status).toBe(401);
    expect(await connection.collection("whatsapp_janelas").countDocuments()).toBe(0);
    expect((await post("/envios/texto", corpoTexto(c.id))).status).toBe(422);
    expect(provedor.textos).toHaveLength(0);
  });

  it("cliente inexistente → 404 na consulta e no envio", async () => {
    expect((await fetch(url("/clientes/65f1a2b3c4d5e6f7a8b9c0d1/texto-livre"), { headers: h() })).status).toBe(404);
    expect((await post("/envios/texto", corpoTexto("65f1a2b3c4d5e6f7a8b9c0d1"))).status).toBe(404);
    expect(provedor.textos).toHaveLength(0);
  });
});
