import { afterEach, describe, expect, it } from "bun:test";
import configuration from "./configuration.js";

const VARIAVEIS_ISOLADAS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_BASE_URL",
  "R2_CONNECTION_TIMEOUT_MS",
  "R2_REQUEST_TIMEOUT_MS",
  "R2_MAX_ATTEMPTS",
  "NODE_ENV",
  "RECONCILIACAO_ESTOQUE_HABILITADA",
  "RECONCILIACAO_ESTOQUE_INTERVALO_MS",
  "RECONCILIACAO_ESTOQUE_LOTE",
  "RECONCILIACAO_ESTOQUE_MAX_ITENS_POR_CICLO",
  "RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS",
  "RECONCILIACAO_ESTOQUE_BACKOFF_BASE_MS",
  "RECONCILIACAO_ESTOQUE_BACKOFF_MAX_MS",
] as const;
const originais = Object.fromEntries(VARIAVEIS_ISOLADAS.map((nome) => [nome, process.env[nome]]));

afterEach(() => {
  for (const nome of VARIAVEIS_ISOLADAS) {
    if (originais[nome] === undefined) delete process.env[nome];
    else process.env[nome] = originais[nome];
  }
});

describe("configuration — storage.r2 (Fase 40)", () => {
  it("sem nenhuma variável R2: tudo vazio (upload desabilitado, o boot não é afetado)", () => {
    for (const nome of VARIAVEIS_ISOLADAS) delete process.env[nome];
    expect(configuration().storage.r2).toEqual({ accountId: "", accessKeyId: "", secretAccessKey: "", bucketName: "", publicBaseUrl: "" });
  });

  it("lê as 5 variáveis, aparando espaços, e remove a(s) barra(s) final(is) da base pública", () => {
    process.env["R2_ACCOUNT_ID"] = "  conta  ";
    process.env["R2_ACCESS_KEY_ID"] = "chave-id";
    process.env["R2_SECRET_ACCESS_KEY"] = "chave-secreta";
    process.env["R2_BUCKET_NAME"] = " bucket ";
    process.env["R2_PUBLIC_BASE_URL"] = " https://midia.exemplo.com// ";
    expect(configuration().storage.r2).toEqual({
      accountId: "conta",
      accessKeyId: "chave-id",
      secretAccessKey: "chave-secreta",
      bucketName: "bucket",
      publicBaseUrl: "https://midia.exemplo.com",
    });
  });
});

describe("configuration — storage.transporte (Fase 60.4.1)", () => {
  it("sem as variáveis de transporte: padrões do projeto (3 s, 10 s, 2 tentativas)", () => {
    for (const nome of VARIAVEIS_ISOLADAS) delete process.env[nome];
    expect(configuration().storage.transporte).toEqual({ timeoutConexaoMs: 3_000, timeoutRequisicaoMs: 10_000, maxTentativas: 2 });
  });

  it("variáveis vazias também caem nos padrões", () => {
    process.env["R2_CONNECTION_TIMEOUT_MS"] = "";
    process.env["R2_REQUEST_TIMEOUT_MS"] = "";
    process.env["R2_MAX_ATTEMPTS"] = "";
    expect(configuration().storage.transporte).toEqual({ timeoutConexaoMs: 3_000, timeoutRequisicaoMs: 10_000, maxTentativas: 2 });
  });

  it("sobrescrita por ambiente", () => {
    process.env["R2_CONNECTION_TIMEOUT_MS"] = "1500";
    process.env["R2_REQUEST_TIMEOUT_MS"] = "4000";
    process.env["R2_MAX_ATTEMPTS"] = "3";
    expect(configuration().storage.transporte).toEqual({ timeoutConexaoMs: 1_500, timeoutRequisicaoMs: 4_000, maxTentativas: 3 });
  });
});

describe("configuration — reconciliacaoEstoque (Fase 60.4.3.4.18)", () => {
  const PADRAO = { intervaloMs: 60_000, loteVendas: 20, maxItensPorCiclo: 50, maxTentativas: 8, esperaBaseMs: 30_000, esperaMaximaMs: 3_600_000 };

  it("Fase 60.4.3.4.18.3 — sem variáveis, EM PRODUÇÃO: worker DESLIGADO (ativação só explícita), com os padrões", () => {
    process.env["NODE_ENV"] = "production";
    for (const nome of VARIAVEIS_ISOLADAS) if (nome.startsWith("RECONCILIACAO_")) delete process.env[nome];
    expect(configuration().reconciliacaoEstoque).toEqual({ habilitada: false, ...PADRAO });
  });

  it("vazia ou qualquer valor diferente de \"true\": desligado, em qualquer ambiente", () => {
    for (const ambiente of ["production", "development", "test"]) {
      process.env["NODE_ENV"] = ambiente;
      for (const valor of ["", "false", " "]) {
        process.env["RECONCILIACAO_ESTOQUE_HABILITADA"] = valor;
        expect(configuration().reconciliacaoEstoque.habilitada).toBe(false);
      }
    }
  });

  it("só `RECONCILIACAO_ESTOQUE_HABILITADA=true` liga o worker", () => {
    process.env["NODE_ENV"] = "production";
    process.env["RECONCILIACAO_ESTOQUE_HABILITADA"] = "true";
    expect(configuration().reconciliacaoEstoque.habilitada).toBe(true);
  });

  it("a variável explícita prevalece sobre o ambiente; números sobrescrevem os padrões", () => {
    process.env["NODE_ENV"] = "production";
    process.env["RECONCILIACAO_ESTOQUE_HABILITADA"] = "false";
    process.env["RECONCILIACAO_ESTOQUE_INTERVALO_MS"] = "15000";
    process.env["RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS"] = "4";
    const config = configuration().reconciliacaoEstoque;
    expect(config.habilitada).toBe(false);
    expect(config.intervaloMs).toBe(15_000);
    expect(config.maxTentativas).toBe(4);
    expect(config.loteVendas).toBe(20);
  });
});
