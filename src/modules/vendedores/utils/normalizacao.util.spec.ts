import { describe, expect, it } from "bun:test";
import { normalizarTelefone } from "./normalizacao.util.js";

describe("normalizarTelefone", () => {
  it("remove máscara e mantém só dígitos", () => {
    expect(normalizarTelefone("(11) 99444-1122")).toBe("11994441122");
  });

  it("já normalizado permanece igual", () => {
    expect(normalizarTelefone("11994441122")).toBe("11994441122");
  });

  it("string vazia vira string vazia", () => {
    expect(normalizarTelefone("")).toBe("");
  });

  it("duas máscaras do mesmo número normalizam para o mesmo valor", () => {
    expect(normalizarTelefone("(11) 9 9444-1122")).toBe(normalizarTelefone("11994441122"));
  });
});
