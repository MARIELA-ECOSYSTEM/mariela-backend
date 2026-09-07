import { describe, expect, it } from "bun:test";
import { normalizarTelefone } from "./normalizacao.util.js";

describe("normalizarTelefone", () => {
  it("remove máscara e mantém só dígitos", () => {
    expect(normalizarTelefone("(11) 98888-7777")).toBe("11988887777");
  });

  it("já normalizado permanece igual", () => {
    expect(normalizarTelefone("11988887777")).toBe("11988887777");
  });

  it("string vazia vira string vazia", () => {
    expect(normalizarTelefone("")).toBe("");
  });

  it("duas máscaras do mesmo número normalizam para o mesmo valor", () => {
    expect(normalizarTelefone("(11) 9 8888-7777")).toBe(normalizarTelefone("11988887777"));
  });
});
