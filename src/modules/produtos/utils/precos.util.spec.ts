import { describe, expect, it } from "bun:test";
import { calcularMargem, precoEfetivo } from "./precos.util.js";

describe("precoEfetivo", () => {
  it("usa o preço de venda quando não há promoção", () => {
    expect(precoEfetivo({ precoVenda: 100, ehPromocao: false, precoPromocional: null })).toBe(100);
  });

  it("usa o preço promocional quando a promoção está ativa", () => {
    expect(precoEfetivo({ precoVenda: 100, ehPromocao: true, precoPromocional: 79.9 })).toBe(79.9);
  });

  it("ignora precoPromocional nulo mesmo com ehPromocao true", () => {
    expect(precoEfetivo({ precoVenda: 100, ehPromocao: true, precoPromocional: null })).toBe(100);
  });
});

describe("calcularMargem", () => {
  it("calcula a margem sobre o preço EFETIVO (não sobre o custo)", () => {
    // custo 50, venda 100 → margem = (100-50)/100 * 100 = 50%
    expect(calcularMargem(50, 100)).toBe(50);
  });

  it("devolve zero quando o preço efetivo é zero ou inválido", () => {
    expect(calcularMargem(50, 0)).toBe(0);
  });
});
