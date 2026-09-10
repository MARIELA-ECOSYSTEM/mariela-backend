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

  it("devolve zero quando o preço efetivo é negativo (guarda <= 0, nunca divide por um valor negativo)", () => {
    expect(calcularMargem(50, -10)).toBe(0);
  });

  // Etapa 18.7 — margem negativa é matematicamente válida (venda abaixo do
  // custo) e não deve ser bloqueada nem capada em zero: só o preço EFETIVO
  // <= 0 devolve 0, nunca o resultado da margem em si.
  it("calcula margem negativa corretamente quando o custo excede o preço efetivo", () => {
    // custo 100, venda 50 → margem = (50-100)/50 * 100 = -100%
    expect(calcularMargem(100, 50)).toBe(-100);
  });
});
