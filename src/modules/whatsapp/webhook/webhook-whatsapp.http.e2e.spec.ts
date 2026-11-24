import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { Logger, ValidationPipe } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import { Types, type Connection } from "mongoose";
import type { AddressInfo } from "node:net";
import { AppModule } from "../../../app.module.js";
import { HttpExceptionFilter } from "../../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../../test-utils/mongo-teste.util.js";
import { MensagensWhatsappRepository } from "../envios/mensagens-whatsapp.repository.js";
import { CONFIG_WEBHOOK_WHATSAPP } from "./configuracao-webhook-meta.js";
import { registrarCorpoBrutoWebhookWhatsapp } from "./corpo-bruto-webhook.js";

/**
 * Fase 22.8.9.10.5 — webhook por HTTP REAL (AppModule inteiro, mesmos pipes/filtro/interceptor/prefixo e o MESMO
 * registro de corpo bruto do `main.ts`). Requisições "da Meta" assinadas aqui com um App Secret FICTÍCIO; nenhuma
 * chamada à Meta.
 */
const SEGREDO = "SEGREDO-FICTICIO-DE-TESTE-WEBHOOK";
const VERIFY = "VERIFY-TOKEN-FICTICIO-DE-TESTE";
const PHONE_ID = "100000000000001";
const TELEFONE = "+5583912340000";

const assinar = (corpo: string | Buffer) => `sha256=${createHmac("sha256", SEGREDO).update(corpo).digest("hex")}`;

async function subirApp(configWebhook: unknown | "padrao") {
  process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (configWebhook !== "padrao") builder.overrideProvider(CONFIG_WEBHOOK_WHATSAPP).useValue(configWebhook);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });
  registrarCorpoBrutoWebhookWhatsapp(app, "api/v1"); // mesmo ponto do `main.ts`: antes do `init`
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  await app.init();
  await app.listen(0);
  const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return { app, baseUrl, connection: app.get<Connection>(getConnectionToken()) };
}

describe("HTTP — webhook WhatsApp configurado (Meta simulada)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let logs: string[] = [];
  let spies: ReturnType<typeof spyOn>[] = [];

  const url = (q = "") => `${baseUrl}/api/v1/integracoes/whatsapp/webhook${q}`;
  const postar = (corpo: string, assinatura: string | null = assinar(corpo), contentType = "application/json") =>
    fetch(url(), { method: "POST", headers: { "content-type": contentType, ...(assinatura !== null ? { "x-hub-signature-256": assinatura } : {}) }, body: corpo });
  const notificacao = (statuses: unknown[]) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "200000000000002", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: PHONE_ID }, statuses } }] }],
    });

  async function mensagemAceita() {
    const repo = app.get(MensagensWhatsappRepository);
    const agora = new Date();
    const m = await repo.reservar(
      {
        idempotencyKey: randomUUID(),
        hashConteudo: "h",
        destinatarioTipo: "CLIENTE",
        destinatarioId: new Types.ObjectId(),
        telefoneE164: TELEFONE,
        templateChave: "aniversario_v1",
        templateNomeMeta: "mariela_aniversario_v1",
        templateIdioma: "pt_BR",
        templateCategoria: "MARKETING",
        origem: "INDIVIDUAL",
        campanhaTipo: null,
        campanhaAno: null,
        chaveDeduplicacao: null,
        usuarioId: null,
      },
      agora,
    );
    await repo.assumirEnvio(m._id, agora);
    const wamid = `wamid.HTTP${randomUUID().replace(/-/g, "")}`;
    await repo.registrarAceita(m._id, wamid, TELEFONE.slice(1), agora);
    return { id: m._id, wamid };
  }
  const estado = async (id: Types.ObjectId) => (await connection.collection("mensagens_whatsapp").findOne({ _id: id }))?.["estado"];

  beforeAll(async () => {
    ({ app, baseUrl, connection } = await subirApp({ verifyToken: VERIFY, appSecret: SEGREDO, phoneNumberId: PHONE_ID }));
    await connection.model("MensagemWhatsapp").init();
    await connection.model("BloqueioWhatsapp").init();
  }, 30_000);

  beforeEach(async () => {
    await connection.collection("mensagens_whatsapp").deleteMany({});
    await connection.collection("whatsapp_bloqueios").deleteMany({});
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
    await app.close();
  });

  function semSegredosNosLogs(...extras: string[]) {
    const tudo = logs.join("\n");
    for (const proibido of [SEGREDO, VERIFY, "sha256=", TELEFONE, TELEFONE.slice(1), ...extras]) expect(tudo).not.toContain(proibido);
  }

  describe("GET — verificação", () => {
    const q = (mode: string, token: string, challenge?: string) =>
      `?hub.mode=${encodeURIComponent(mode)}&hub.verify_token=${encodeURIComponent(token)}${challenge !== undefined ? `&hub.challenge=${encodeURIComponent(challenge)}` : ""}`;

    it("válida → 200 text/plain com exatamente o challenge", async () => {
      const r = await fetch(url(q("subscribe", VERIFY, "1158201444")));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toStartWith("text/plain");
      expect(await r.text()).toBe("1158201444");
      semSegredosNosLogs("1158201444");
    });

    it("token inválido, mode inválido, challenge ausente/inseguro, parâmetros repetidos → 403 genérico, sem refletir nada", async () => {
      for (const consulta of [
        q("subscribe", "errado", "123"),
        q("unsubscribe", VERIFY, "123"),
        q("subscribe", VERIFY),
        q("subscribe", VERIFY, "<b>x</b>"),
        `${q("subscribe", VERIFY, "123")}&hub.challenge=456`,
        `${q("subscribe", VERIFY, "123")}&hub.verify_token=${VERIFY}`,
        "",
      ]) {
        const r = await fetch(url(consulta));
        expect(r.status).toBe(403);
        const t = await r.text();
        expect(t).not.toContain(VERIFY);
        expect(t).not.toContain("123");
        expect(t).not.toContain("<b>");
      }
      semSegredosNosLogs();
    });
  });

  describe("POST — assinatura e corpo original", () => {
    it("assinatura válida → 200 e o evento é aplicado (delivered)", async () => {
      const m = await mensagemAceita();
      const r = await postar(notificacao([{ id: m.wamid, status: "delivered", timestamp: "1764000000", recipient_id: TELEFONE.slice(1) }]));
      expect(r.status).toBe(200);
      expect(await estado(m.id)).toBe("entregue");
      semSegredosNosLogs(m.wamid);
    });

    it("corpo original preservado: JSON com espaços, quebras e unicode escapado é validado pelos BYTES recebidos", async () => {
      const m = await mensagemAceita();
      const corpo = notificacao([{ id: m.wamid, status: "read", timestamp: "1764000001" }]).replace('"statuses"', '\n  "statuses"  ').replace("whatsapp\"", 'what\\u0073app"');
      const r = await postar(corpo);
      expect(r.status).toBe(200);
      expect(await estado(m.id)).toBe("lida");
    });

    it("assinatura inválida, ausente, de outro corpo ou corpo alterado após assinar → 401 e NADA é processado", async () => {
      const m = await mensagemAceita();
      const corpo = notificacao([{ id: m.wamid, status: "read" }]);
      for (const [c, a] of [
        [corpo, `sha256=${"0".repeat(64)}`],
        [corpo, null],
        [corpo, assinar(notificacao([]))],
        [corpo.replace('"read"', '"delivered"'), assinar(corpo)],
        [corpo, assinar(corpo).replace("sha256=", "sha1=")],
      ] as [string, string | null][]) {
        const r = await postar(c, a);
        expect(r.status).toBe(401);
        expect(await r.json()).toEqual({ statusCode: 401, code: "UNAUTHORIZED", message: "Assinatura inválida." });
      }
      expect(await estado(m.id)).toBe("aceita");
      semSegredosNosLogs(m.wamid);
    });

    it("corpo vazio → 400; JSON malformado (assinado) → 400; tipo não-JSON (assinado) → 415; envelope fora do contrato → 400", async () => {
      expect((await postar("", assinar(""))).status).toBe(400);
      expect((await postar("{malformado", assinar("{malformado"))).status).toBe(400);
      expect((await postar(notificacao([]), assinar(notificacao([])), "text/plain")).status).toBe(415);
      const fora = JSON.stringify({ object: "page", entry: [] });
      expect((await postar(fora)).status).toBe(400);
      semSegredosNosLogs("malformado");
    });

    it("corpo acima de 3 MB → 413 JSON genérico (sem página de erro nem stack)", async () => {
      const grande = `{"x":"${"a".repeat(3 * 1024 * 1024 + 10)}"}`;
      const r = await postar(grande, assinar(grande));
      expect(r.status).toBe(413);
      const t = await r.text();
      expect(t).not.toContain("at ");
      expect(JSON.parse(t)).toMatchObject({ statusCode: 413, message: "Corpo inválido." });
    });

    it("evento repetido (reentrega) → 200 de novo, sem efeito duplicado", async () => {
      const m = await mensagemAceita();
      const corpo = notificacao([{ id: m.wamid, status: "failed", errors: [{ code: 131050 }] }]);
      expect((await postar(corpo)).status).toBe(200);
      expect((await postar(corpo)).status).toBe(200);
      expect(await estado(m.id)).toBe("falha");
      expect(await connection.collection("whatsapp_bloqueios").countDocuments({ ativo: true })).toBe(1);
    });

    describe("Fase 22.8.9.10.7.2 — mensagens recebidas não geram bloqueio (palavras-chave removidas, AppModule real)", () => {
      const REMETENTE = "5583912349999";
      const mensagemTexto = (body: string, from = REMETENTE) =>
        JSON.stringify({
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
                    contacts: [{ profile: { name: "Contato Ficticio" }, wa_id: from }],
                    messages: [{ from, id: `wamid.IN${randomUUID().replace(/-/g, "")}`, timestamp: "1764000000", type: "text", text: { body } }],
                  },
                },
              ],
            },
          ],
        });
      const bloqueiosAtivos = () => connection.collection("whatsapp_bloqueios").countDocuments({ chave: REMETENTE, ativo: true });

      it("assinatura válida + SAIR/PARAR/CANCELAR/STOP/UNSUBSCRIBE → 200 e NENHUM bloqueio; logs sem texto, número ou nome", async () => {
        for (const t of [" Sair ", "SAIR", "PARAR", "Cancelar", "STOP", "unsubscribe"]) {
          const corpo = mensagemTexto(t);
          expect((await postar(corpo)).status).toBe(200);
          expect((await postar(corpo)).status).toBe(200);
        }
        expect(await connection.collection("whatsapp_bloqueios").countDocuments({})).toBe(0);
        semSegredosNosLogs(REMETENTE, REMETENTE.slice(2), "Sair", "Contato Ficticio");
      });

      it("assinatura inválida/ausente com 'SAIR' → 401 e NENHUM bloqueio", async () => {
        const corpo = mensagemTexto("SAIR");
        expect((await postar(corpo, `sha256=${"0".repeat(64)}`)).status).toBe(401);
        expect((await postar(corpo, null)).status).toBe(401);
        expect((await postar(corpo, assinar(mensagemTexto("oi")))).status).toBe(401);
        expect(await bloqueiosAtivos()).toBe(0);
      });

      it("frases com a palavra ('Não quero cancelar meu pedido') → 200 sem bloqueio e sem o texto nos logs", async () => {
        for (const t of ["Não quero cancelar meu pedido", "Quero saber como sair da promoção", "Sair?"]) expect((await postar(mensagemTexto(t))).status).toBe(200);
        expect(await bloqueiosAtivos()).toBe(0);
        semSegredosNosLogs(REMETENTE, "cancelar meu pedido", "sair da promo");
      });
    });

    it("evento desconhecido / wamid inexistente → 200 sem criar registro", async () => {
      const r = await postar(notificacao([{ id: "wamid.NAO_EXISTE", status: "delivered" }, { id: "wamid.X", status: "played" }]));
      expect(r.status).toBe(200);
      expect(await connection.collection("mensagens_whatsapp").countDocuments({})).toBe(0);
    });

    it("falha de processamento → 500 genérico (a Meta reentrega); nenhum detalhe interno na resposta nem nos logs", async () => {
      const m = await mensagemAceita();
      const spy = spyOn(MensagensWhatsappRepository.prototype, "encontrarPorWamid").mockImplementation(async () => {
        throw new Error(`falha do banco com ${TELEFONE} e ${SEGREDO}`);
      });
      try {
        const r = await postar(notificacao([{ id: m.wamid, status: "delivered" }]));
        expect(r.status).toBe(500);
        const t = await r.text();
        expect(JSON.parse(t)).toEqual({ statusCode: 500, code: "INTERNAL_ERROR", message: "Falha ao processar a notificação." });
        expect(t).not.toContain("falha do banco");
      } finally {
        spy.mockRestore();
      }
      semSegredosNosLogs("falha do banco");
      // Reentrega depois da recuperação: aplicada normalmente.
      expect((await postar(notificacao([{ id: m.wamid, status: "delivered" }]))).status).toBe(200);
      expect(await estado(m.id)).toBe("entregue");
    });
  });

  describe("regressão do HTTP global", () => {
    it("outras rotas JSON continuam com o parser global (login com corpo JSON → 401 de credencial, não 400 de corpo)", async () => {
      const r = await fetch(`${baseUrl}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usuario: "ninguem@mariela.dev", senha: "senha-errada-123" }) });
      expect(r.status).toBe(401);
    });

    it("rotas autenticadas continuam exigindo JWT; /health responde", async () => {
      expect((await fetch(`${baseUrl}/api/v1/integracoes/whatsapp/envios`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    });
  });
});

describe("HTTP — webhook com a configuração PADRÃO (sem variáveis da Meta)", () => {
  const nomes = ["META_WHATSAPP_WEBHOOK_VERIFY_TOKEN", "META_WHATSAPP_APP_SECRET", "META_WHATSAPP_PHONE_NUMBER_ID"] as const;
  const anteriores = Object.fromEntries(nomes.map((n) => [n, process.env[n]]));
  let ctx: Awaited<ReturnType<typeof subirApp>>;

  beforeAll(async () => {
    for (const n of nomes) process.env[n] = ""; // determinístico mesmo com variáveis locais
    ctx = await subirApp("padrao");
  }, 30_000);

  afterAll(async () => {
    for (const n of nomes) {
      if (anteriores[n] === undefined) delete process.env[n];
      else process.env[n] = anteriores[n];
    }
    await ctx.app.close();
  });

  it("webhook DESATIVADO: GET → 403, POST → 503; nada é processado", async () => {
    const base = `${ctx.baseUrl}/api/v1/integracoes/whatsapp/webhook`;
    expect((await fetch(`${base}?hub.mode=subscribe&hub.verify_token=qualquer&hub.challenge=1`)).status).toBe(403);
    const corpo = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const r = await fetch(base, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": assinar(corpo) }, body: corpo });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe("WHATSAPP_NOT_CONFIGURED");
  });
});
