import { describe, expect, it } from "bun:test";
import { normalizarTelefone } from "./normalizacao.util.js";

describe("normalizarTelefone", () => {
  it("remove máscara e mantém só dígitos", () => {
    expect(normalizarTelefone("(83) 99999-9999")).toBe("83999999999");
  });

  it("já normalizado permanece igual", () => {
    expect(normalizarTelefone("83999999999")).toBe("83999999999");
  });

  it("string vazia vira string vazia", () => {
    expect(normalizarTelefone("")).toBe("");
  });

  it("duas máscaras do mesmo número normalizam para o mesmo valor", () => {
    expect(normalizarTelefone("(83) 9 9999-9999")).toBe(normalizarTelefone("83999999999"));
  });
});
