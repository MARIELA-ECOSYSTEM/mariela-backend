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
  // Correção pós-go-live: margem passou a ser calculada sobre o preço de
  // CUSTO, não mais sobre o preço efetivo (venda). Casos exigidos pela
  // correção (custo 100, venda 220 → 120%, etc.).
  it("custo 100, venda 220 → 120%", () => {
    expect(calcularMargem(100, 220)).toBe(120);
  });

  it("custo 100, venda 100 → 0%", () => {
    expect(calcularMargem(100, 100)).toBe(0);
  });

  it("custo 100, venda 80 → -20% (venda abaixo do custo, margem negativa válida)", () => {
    expect(calcularMargem(100, 80)).toBe(-20);
  });

  it("custo 50, venda 100 → 100%", () => {
    expect(calcularMargem(50, 100)).toBe(100);
  });

  it("devolve zero quando o preço de CUSTO é zero (evita divisão por zero)", () => {
    expect(calcularMargem(0, 220)).toBe(0);
  });

  it("devolve zero quando o preço de custo é negativo/inválido (guarda <= 0, nunca divide por um valor inválido)", () => {
    expect(calcularMargem(-10, 220)).toBe(0);
  });

  it("nunca produz Infinity/NaN mesmo com preço efetivo zero, desde que o custo seja válido", () => {
    const resultado = calcularMargem(100, 0);
    expect(Number.isFinite(resultado)).toBe(true);
    expect(resultado).toBe(-100); // venda zero → perda total do custo → -100%
  });
});
