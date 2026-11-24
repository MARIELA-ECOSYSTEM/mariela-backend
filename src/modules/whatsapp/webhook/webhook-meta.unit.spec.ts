import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { WhatsappConfig } from "../../../config/configuration.js";
import { assinaturaWebhookValida, verificarDesafioGet } from "./assinatura-webhook-meta.js";
import { lerConfiguracaoWebhookMeta } from "./configuracao-webhook-meta.js";
import { ErroContratoWebhookMeta, interpretarNotificacaoMeta } from "./contrato-webhook-meta.js";
import {
  criarReconhecedorOptOut,
  normalizarTextoOptOut,
  PALAVRAS_CHAVE_OPT_OUT_APROVADAS,
  TAMANHO_MAXIMO_MENSAGEM_OPT_OUT,
} from "./opt-out-palavras-chave.js";

/**
 * Fase 22.8.9.10.5 — regras PURAS do webhook (sem rede, sem MongoDB). Segredos são marcadores fictícios evidentes.
 */
const SEGREDO = "SEGREDO-FICTICIO-DE-TESTE-WEBHOOK";
const VERIFY = "VERIFY-TOKEN-FICTICIO-DE-TESTE";
const PHONE_ID = "100000000000001";

const assinar = (corpo: Buffer | string, segredo = SEGREDO) => `sha256=${createHmac("sha256", segredo).update(corpo).digest("hex")}`;

describe("assinatura X-Hub-Signature-256 (HMAC-SHA256 dos bytes originais)", () => {
  const corpo = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

  it("assinatura válida (hex minúsculo ou maiúsculo)", () => {
    expect(assinaturaWebhookValida(corpo, assinar(corpo), SEGREDO)).toBe(true);
    expect(assinaturaWebhookValida(corpo, `sha256=${assinar(corpo).slice(7).toUpperCase()}`, SEGREDO)).toBe(true);
  });

  it("assinatura ausente, vazia, sem prefixo, curta, não-hex, repetida (array) → inválida", () => {
    const valida = assinar(corpo);
    for (const header of [undefined, "", valida.slice(7), "sha256=", "sha256=abc", `sha256=${"z".repeat(64)}`, `sha1=${valida.slice(7)}`, [valida, valida], ` ${valida}`]) {
      expect(assinaturaWebhookValida(corpo, header, SEGREDO)).toBe(false);
    }
  });

  it("segredo errado ou corpo alterado depois da assinatura → inválida", () => {
    expect(assinaturaWebhookValida(corpo, assinar(corpo, "OUTRO-SEGREDO-QUALQUER-123"), SEGREDO)).toBe(false);
    const alterado = Buffer.from(corpo.toString().replace("[]", "[ ]"));
    expect(assinaturaWebhookValida(alterado, assinar(corpo), SEGREDO)).toBe(false);
  });

  it("sobre os BYTES: a mesma estrutura JSON reserializada (espaços, unicode escapado) não confere", () => {
    const original = Buffer.from('{"a": "Jo\\u00e3o",  "b":1}');
    const reserializado = Buffer.from(JSON.stringify(JSON.parse(original.toString())));
    expect(assinaturaWebhookValida(original, assinar(original), SEGREDO)).toBe(true);
    expect(assinaturaWebhookValida(reserializado, assinar(original), SEGREDO)).toBe(false);
  });
});

describe("verificação GET (hub.mode, hub.verify_token, hub.challenge)", () => {
  const q = (extra: Record<string, unknown> = {}) => ({ "hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "1158201444", ...extra });

  it("válida → devolve exatamente o challenge", () => {
    expect(verificarDesafioGet(q(), VERIFY)).toBe("1158201444");
  });

  it("token inválido, mode inválido, challenge ausente/inseguro ou parâmetros repetidos → null", () => {
    expect(verificarDesafioGet(q({ "hub.verify_token": "errado" }), VERIFY)).toBeNull();
    expect(verificarDesafioGet(q({ "hub.verify_token": `${VERIFY}x` }), VERIFY)).toBeNull();
    expect(verificarDesafioGet(q({ "hub.mode": "unsubscribe" }), VERIFY)).toBeNull();
    expect(verificarDesafioGet(q({ "hub.mode": "SUBSCRIBE" }), VERIFY)).toBeNull();
    expect(verificarDesafioGet(q({ "hub.challenge": undefined }), VERIFY)).toBeNull();
    expect(verificarDesafioGet(q({ "hub.challenge": "<script>alert(1)</script>" }), VERIFY)).toBeNull();
    expect(verificarDesafioGet(q({ "hub.challenge": "a".repeat(257) }), VERIFY)).toBeNull();
    expect(verificarDesafioGet(q({ "hub.verify_token": [VERIFY, VERIFY] }), VERIFY)).toBeNull();
    expect(verificarDesafioGet(q({ "hub.challenge": ["1", "2"] }), VERIFY)).toBeNull();
    expect(verificarDesafioGet({}, VERIFY)).toBeNull();
  });
});

describe("configuração do webhook", () => {
  const cfg = (verifyToken: string, appSecret: string, phoneNumberId = PHONE_ID): WhatsappConfig => ({
    ownerPhone: "",
    evolution: { apiUrl: "", apiKey: "", instanceName: "x", timeoutMs: 1 },
    meta: { graphApiVersion: "v26.0", phoneNumberId, businessAccountId: "2", accessToken: "", timeoutMs: 1 },
    metaWebhook: { verifyToken, appSecret },
  });

  it("completa → válida; ausente/curta/com espaço/sem Phone Number ID → inválida (só nomes de campo)", () => {
    expect(lerConfiguracaoWebhookMeta(cfg(VERIFY, SEGREDO))).toEqual({ valida: true, config: { verifyToken: VERIFY, appSecret: SEGREDO, phoneNumberId: PHONE_ID } });
    expect(lerConfiguracaoWebhookMeta(undefined)).toEqual({ valida: false, camposInvalidos: ["verifyToken", "appSecret", "phoneNumberId"] });
    expect(lerConfiguracaoWebhookMeta(cfg("curto", SEGREDO))).toEqual({ valida: false, camposInvalidos: ["verifyToken"] });
    expect(lerConfiguracaoWebhookMeta(cfg(VERIFY, "com espaco no meio 123"))).toEqual({ valida: false, camposInvalidos: ["appSecret"] });
    expect(lerConfiguracaoWebhookMeta(cfg(VERIFY, SEGREDO, ""))).toEqual({ valida: false, camposInvalidos: ["phoneNumberId"] });
    expect(JSON.stringify(lerConfiguracaoWebhookMeta(cfg("curto", "x")))).not.toContain("curto");
  });
});

describe("palavras-chave de opt-out (Fase 22.8.9.10.7.1)", () => {
  const r = criarReconhecedorOptOut(PALAVRAS_CHAVE_OPT_OUT_APROVADAS);

  it("lista APROVADA: SAIR, PARAR, CANCELAR, STOP, UNSUBSCRIBE (congelada)", () => {
    expect(PALAVRAS_CHAVE_OPT_OUT_APROVADAS).toEqual(["SAIR", "PARAR", "CANCELAR", "STOP", "UNSUBSCRIBE"]);
    expect(Object.isFrozen(PALAVRAS_CHAVE_OPT_OUT_APROVADAS)).toBe(true);
  });

  it("cada palavra-chave, em qualquer caixa, é reconhecida", () => {
    for (const p of PALAVRAS_CHAVE_OPT_OUT_APROVADAS) {
      const minuscula = p.toLowerCase();
      const capitalizada = p[0] + p.slice(1).toLowerCase();
      for (const t of [p, minuscula, capitalizada, minuscula.replace(/^./, (c) => c.toUpperCase()).replace(/.$/, (c) => c.toUpperCase())]) {
        expect([t, r(t)]).toEqual([t, true]);
      }
    }
  });

  it("exemplos da especificação: 'SAIR', 'sair', ' PARAR ', 'Cancelar' bloqueiam", () => {
    for (const t of ["SAIR", "sair", " PARAR ", "Cancelar"]) expect([t, r(t)]).toEqual([t, true]);
  });

  it("espaços e caracteres invisíveis nas pontas: tabulação, quebra de linha, espaço não separável, zero-width, BOM", () => {
    for (const t of ["\tSAIR\n", "\n\n parar \r\n", " Stop ", "​sair​", "﻿CANCELAR", "unsubscribe⁠"]) {
      expect([JSON.stringify(t), r(t)]).toEqual([JSON.stringify(t), true]);
    }
  });

  it("acentos normalizados (e forma decomposta Unicode)", () => {
    for (const t of ["SAÍR", "sáir", "Párar", "CANCELÁR", "Sáir", "ｓａｉｒ"]) expect([t, r(t)]).toEqual([t, true]);
  });

  it("uma pontuação final de afirmação é tolerada ('.', '!', até 3)", () => {
    for (const t of ["Sair.", "PARAR!", "stop!!!", "Cancelar !", "SAIR.!"]) expect([t, r(t)]).toEqual([t, true]);
  });

  it("FALSOS POSITIVOS: palavra dentro de frase, pergunta, repetição, letras separadas, prefixo/sufixo, outra pontuação → NÃO", () => {
    for (const t of [
      "Quero saber como sair da promoção",
      "Não quero cancelar meu pedido",
      "Esse produto é ótimo",
      "quero SAIR",
      "SAIR da lista por favor",
      "Sair?",
      "parar?",
      "SAIR SAIR",
      "S A I R",
      "S-A-I-R",
      "#SAIR",
      "SAIR123",
      "sairr",
      "SAIRE",
      "Desistir",
      "stop!!!!",
      "\"SAIR\"",
      "SAIR 😀",
      "pare",
      "não",
      "cancela",
      "unsubscribe me",
      "",
      "   ",
      "!!!",
      "SAIR".padEnd(80, " ") + "x",
    ]) {
      expect([t, r(t)]).toEqual([t, false]);
    }
  });

  it("texto longo nunca é analisado; lista vazia não reconhece nada; listas de teste usam a mesma normalização", () => {
    expect(normalizarTextoOptOut(`SAIR${" ".repeat(TAMANHO_MAXIMO_MENSAGEM_OPT_OUT)}`)).toBeNull();
    expect(normalizarTextoOptOut("  sáir. ")).toBe("SAIR");
    const vazia = criarReconhecedorOptOut([]);
    for (const t of ["SAIR", "sair", "PARAR", "STOP", ""]) expect(vazia(t)).toBe(false);
    const teste = criarReconhecedorOptOut(["Sair"]);
    expect(teste("SAIR")).toBe(true);
    expect(teste("PARAR")).toBe(false);
  });
});

describe("contrato da notificação (POST)", () => {
  const reconhecer = criarReconhecedorOptOut(["SAIR"]);
  const envelope = (changes: unknown[]) => ({ object: "whatsapp_business_account", entry: [{ id: "200000000000002", changes }] });
  const meta = { display_phone_number: "15550000000", phone_number_id: PHONE_ID };
  const statusValor = (statuses: unknown[], phone = PHONE_ID) => ({ field: "messages", value: { messaging_product: "whatsapp", metadata: { ...meta, phone_number_id: phone }, statuses } });

  it("envelope fora do contrato → ErroContratoWebhookMeta", () => {
    for (const json of [null, [], "x", {}, { object: "page", entry: [] }, { object: "whatsapp_business_account" }, { object: "whatsapp_business_account", entry: [{}] }, envelope([{ field: 1, value: {} }]), envelope([{ field: "messages" }])]) {
      expect(() => interpretarNotificacaoMeta(json, PHONE_ID, reconhecer)).toThrow(ErroContratoWebhookMeta);
    }
  });

  it("statuses documentados: id (wamid), status, timestamp e errors[0].code", () => {
    const n = interpretarNotificacaoMeta(
      envelope([
        statusValor([
          { id: "wamid.A", status: "delivered", timestamp: "1750263773", recipient_id: "5583912345678" },
          { id: "wamid.B", status: "failed", timestamp: "1750263774", errors: [{ code: 131049, title: "x" }] },
          { id: "wamid.C", status: "read" },
        ]),
      ]),
      PHONE_ID,
      reconhecer,
    );
    expect(n.statuses).toEqual([
      { wamid: "wamid.A", status: "delivered", ocorridoEm: new Date(1750263773000), codigoErro: null },
      { wamid: "wamid.B", status: "failed", ocorridoEm: new Date(1750263774000), codigoErro: 131049 },
      { wamid: "wamid.C", status: "read", ocorridoEm: null, codigoErro: null },
    ]);
  });

  it("status desconhecido (played), item malformado, outro Phone Number ID e campo não suportado: ignorados e contados", () => {
    const n = interpretarNotificacaoMeta(
      envelope([
        statusValor([{ id: "wamid.A", status: "played" }, { id: "<script>", status: "read" }, { status: "read" }, "x"]),
        statusValor([{ id: "wamid.Z", status: "read" }], "999999999999999"),
        { field: "account_update", value: { x: 1 } },
      ]),
      PHONE_ID,
      reconhecer,
    );
    expect(n.statuses).toEqual([]);
    expect(n.contagem).toMatchObject({ statusIgnorados: 1, itensInvalidos: 3, outroNumero: 1, camposIgnorados: 1 });
  });

  it("mensagem de texto com palavra-chave → opt-out pelo `from` exato; outras mensagens/tipos não", () => {
    const msgs = (messages: unknown[]) => ({ field: "messages", value: { messaging_product: "whatsapp", metadata: meta, contacts: [{ wa_id: "5583912345678" }], messages } });
    const n = interpretarNotificacaoMeta(
      envelope([
        msgs([
          { from: "5583912345678", id: "wamid.1", timestamp: "1", type: "text", text: { body: "SAIR" } },
          { from: "5583900000001", id: "wamid.2", timestamp: "1", type: "text", text: { body: "Oi, tudo bem?" } },
          { from: "5583900000002", id: "wamid.3", timestamp: "1", type: "button", button: { text: "SAIR", payload: "SAIR" } },
          { from_user_id: "BR.123", id: "wamid.4", timestamp: "1", type: "text", text: { body: "SAIR" } },
        ]),
      ]),
      PHONE_ID,
      reconhecer,
    );
    expect(n.optOuts).toEqual([{ waId: "5583912345678", origem: "PALAVRA_CHAVE" }]);
    expect(n.contagem).toMatchObject({ mensagensRecebidas: 4, semIdentificadorTelefone: 1 });
    expect(JSON.stringify(n)).not.toContain("Oi, tudo bem");
  });

  it("user_preferences: só stop de marketing_messages bloqueia; resume e outras categorias são ignorados", () => {
    const pref = (user_preferences: unknown[]) => ({ field: "user_preferences", value: { messaging_product: "whatsapp", metadata: meta, user_preferences } });
    const n = interpretarNotificacaoMeta(
      envelope([
        pref([
          { wa_id: "5583912345678", category: "marketing_messages", value: "stop", timestamp: 1731705721 },
          { wa_id: "5583900000001", category: "marketing_messages", value: "resume", timestamp: 1731705721 },
          { wa_id: "5583900000002", category: "outra", value: "stop" },
          { user_id: "BR.1", category: "marketing_messages", value: "stop" },
        ]),
      ]),
      PHONE_ID,
      reconhecer,
    );
    expect(n.optOuts).toEqual([{ waId: "5583912345678", origem: "META_OPT_OUT" }]);
    expect(n.contagem).toMatchObject({ preferenciasIgnoradas: 2, semIdentificadorTelefone: 1 });
  });
});
