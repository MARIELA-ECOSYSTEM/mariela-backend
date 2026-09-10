import { describe, expect, it } from "bun:test";
import { arredondar } from "./dinheiro.util.js";

describe("arredondar", () => {
  it("arredonda para duas casas decimais", () => {
    expect(arredondar(10.126)).toBe(10.13);
    expect(arredondar(10.124)).toBe(10.12);
  });

  it("não altera um valor que já tem no máximo duas casas decimais", () => {
    expect(arredondar(149.99)).toBe(149.99);
    expect(arredondar(0)).toBe(0);
  });

  it("arredonda valores negativos corretamente (sangria/diferença podem ser negativos)", () => {
    expect(arredondar(-10.126)).toBe(-10.13);
  });

  it("Etapa 18.16 — arredonda meio-centavo consistentemente com arredondarMoeda (Math.round), não com Number(toFixed(2))", () => {
    // `Number((0.015).toFixed(2))` daria 0.01 — divergiria de arredondarMoeda (produtos/utils/precos.util.ts).
    expect(arredondar(0.015)).toBe(0.02);
    expect(arredondar(0.045)).toBe(0.05);
  });
});
