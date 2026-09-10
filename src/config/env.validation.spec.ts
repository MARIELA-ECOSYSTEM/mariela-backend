import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { validateEnv } from "./env.validation.js";

const SEGREDO_VALIDO_CURTO = "segredo-de-teste-123";
const SEGREDO_VALIDO_LONGO = "a".repeat(32);

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MONGODB_URI: "mongodb://localhost:27017/mariela",
    JWT_ACCESS_SECRET: SEGREDO_VALIDO_CURTO,
    JWT_REFRESH_SECRET: SEGREDO_VALIDO_CURTO,
    PDV_JWT_ACCESS_SECRET: SEGREDO_VALIDO_CURTO,
    PDV_JWT_REFRESH_SECRET: SEGREDO_VALIDO_CURTO,
    ...overrides,
  };
}

describe("validateEnv", () => {
  it("aceita uma configuração válida mínima (development)", () => {
    const validado = validateEnv(baseEnv());
    expect(validado.NODE_ENV).toBe("development" as never);
    expect(validado.JWT_ACCESS_SECRET).toBe(SEGREDO_VALIDO_CURTO);
  });

  it("rejeita MONGODB_URI ausente", () => {
    const env = baseEnv();
    delete (env as Record<string, string | undefined>)["MONGODB_URI"];
    expect(() => validateEnv(env)).toThrow();
  });

  describe("Etapa 18.23 — segredos JWT vazios/whitespace", () => {
    for (const campo of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "PDV_JWT_ACCESS_SECRET", "PDV_JWT_REFRESH_SECRET"]) {
      it(`rejeita ${campo} ausente`, () => {
        const env = baseEnv();
        delete (env as Record<string, string | undefined>)[campo];
        expect(() => validateEnv(env)).toThrow();
      });

      it(`rejeita ${campo} vazio`, () => {
        expect(() => validateEnv(baseEnv({ [campo]: "" }))).toThrow();
      });

      it(`rejeita ${campo} contendo somente espaços`, () => {
        expect(() => validateEnv(baseEnv({ [campo]: "   " }))).toThrow();
      });

      it(`aceita ${campo} curto (não-vazio) fora de produção`, () => {
        expect(() => validateEnv(baseEnv({ NODE_ENV: "development", [campo]: SEGREDO_VALIDO_CURTO }))).not.toThrow();
      });
    }
  });

  describe("Etapa 18.23 — tamanho mínimo de segredo em produção", () => {
    it("aceita segredos curtos (não-vazios) quando NODE_ENV=development", () => {
      expect(() => validateEnv(baseEnv({ NODE_ENV: "development" }))).not.toThrow();
    });

    it("aceita segredos curtos (não-vazios) quando NODE_ENV=test", () => {
      expect(() => validateEnv(baseEnv({ NODE_ENV: "test" }))).not.toThrow();
    });

    it("rejeita segredo curto quando NODE_ENV=production", () => {
      expect(() => validateEnv(baseEnv({ NODE_ENV: "production" }))).toThrow(/pelo menos 32 caracteres/);
    });

    it("aceita todos os segredos com pelo menos 32 caracteres quando NODE_ENV=production", () => {
      expect(() =>
        validateEnv(
          baseEnv({
            NODE_ENV: "production",
            JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
            JWT_REFRESH_SECRET: SEGREDO_VALIDO_LONGO,
            PDV_JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
            PDV_JWT_REFRESH_SECRET: SEGREDO_VALIDO_LONGO,
          }),
        ),
      ).not.toThrow();
    });

    it("mensagem de erro em produção lista exatamente os campos curtos, não os já válidos", () => {
      let mensagem = "";
      try {
        validateEnv(
          baseEnv({
            NODE_ENV: "production",
            JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
            JWT_REFRESH_SECRET: SEGREDO_VALIDO_CURTO,
            PDV_JWT_ACCESS_SECRET: SEGREDO_VALIDO_LONGO,
            PDV_JWT_REFRESH_SECRET: SEGREDO_VALIDO_CURTO,
          }),
        );
      } catch (erro) {
        mensagem = erro instanceof Error ? erro.message : String(erro);
      }
      expect(mensagem).toContain("JWT_REFRESH_SECRET");
      expect(mensagem).toContain("PDV_JWT_REFRESH_SECRET");
      expect(mensagem).not.toContain("JWT_ACCESS_SECRET,");
    });
  });
});
