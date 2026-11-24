import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lerConfiguracaoMeta } from "../modules/whatsapp/providers/meta/configuracao-meta.js";
import { criarProvedorEnvioWhatsapp } from "../modules/whatsapp/providers/selecionar-provedor-envio.js";
import { ProvedorEnvioDesativado } from "../modules/whatsapp/providers/provedor-envio-desativado.js";
import { lerConfiguracaoWebhookMeta } from "../modules/whatsapp/webhook/configuracao-webhook-meta.js";
import configuration from "./configuration.js";
import { validateEnv } from "./env.validation.js";

/**
 * Fase 22.8.9.10.5.1 — o `.env.example` (arquivo VERSIONADO de exemplo; o `.env` real nunca é lido) continua aceito
 * pela validação e, copiado como está, mantém o envio por template e o webhook da Meta DESATIVADOS.
 */
const EXEMPLO = readFileSync(join(import.meta.dir, "..", "..", ".env.example"), "utf8");

function lerExemplo(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const linha of EXEMPLO.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(linha);
    if (m) vars[m[1]!] = m[2]!;
  }
  return vars;
}

const VARIAVEIS_META = [
  "WHATSAPP_PROVEDOR_ENVIO",
  "META_WHATSAPP_GRAPH_API_VERSION",
  "META_WHATSAPP_PHONE_NUMBER_ID",
  "META_WHATSAPP_BUSINESS_ACCOUNT_ID",
  "META_WHATSAPP_ACCESS_TOKEN",
  "META_WHATSAPP_TIMEOUT_MS",
  "META_WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "META_WHATSAPP_APP_SECRET",
] as const;
const originais = Object.fromEntries(VARIAVEIS_META.map((n) => [n, process.env[n]]));

afterEach(() => {
  for (const n of VARIAVEIS_META) {
    if (originais[n] === undefined) delete process.env[n];
    else process.env[n] = originais[n];
  }
});

describe(".env.example — WhatsApp Cloud API (Fase 22.8.9.10.5.1)", () => {
  it("documenta todas as variáveis da Meta, todas VAZIAS (nenhum valor que possa ativar algo)", () => {
    const vars = lerExemplo();
    for (const n of VARIAVEIS_META) expect(vars[n]).toBe("");
  });

  it("é aceito pela validação de ambiente (a API sobe com o exemplo)", () => {
    expect(() => validateEnv(lerExemplo())).not.toThrow();
  });

  it("com os valores do exemplo, o envio fica desativado e o webhook também", () => {
    const vars = lerExemplo();
    for (const n of VARIAVEIS_META) process.env[n] = vars[n];
    const whatsapp = configuration().whatsapp;
    expect(whatsapp.provedorEnvio).toBe("desativado");
    expect(criarProvedorEnvioWhatsapp(whatsapp)).toBeInstanceOf(ProvedorEnvioDesativado);
    expect(lerConfiguracaoMeta(whatsapp.meta).valida).toBe(false);
    expect(lerConfiguracaoWebhookMeta(whatsapp).valida).toBe(false);
  });
});
