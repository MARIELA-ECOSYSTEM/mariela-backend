import { afterEach, describe, expect, it } from "bun:test";
import configuration from "./configuration.js";

const VARIAVEIS_R2 = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL"] as const;
const originais = Object.fromEntries(VARIAVEIS_R2.map((nome) => [nome, process.env[nome]]));

afterEach(() => {
  for (const nome of VARIAVEIS_R2) {
    if (originais[nome] === undefined) delete process.env[nome];
    else process.env[nome] = originais[nome];
  }
});

describe("configuration — storage.r2 (Fase 40)", () => {
  it("sem nenhuma variável R2: tudo vazio (upload desabilitado, o boot não é afetado)", () => {
    for (const nome of VARIAVEIS_R2) delete process.env[nome];
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
