import { describe, expect, it } from "bun:test";
import { calcularFaturamento } from "./faturamento.util.js";

describe("calcularFaturamento (Fase 29B.1 — fórmula canônica de faturamento)", () => {
  it("venda normal sem devolução: bruto = líquido = valorFinal", () => {
    const resultado = calcularFaturamento([{ status: "concluida", valorFinal: 100, valorDevolvido: 0 }]);
    expect(resultado.faturamentoBruto).toBe(100);
    expect(resultado.faturamentoLiquido).toBe(100);
  });

  it("devolução parcial: bruto mantém valorFinal, líquido desconta valorDevolvido", () => {
    const resultado = calcularFaturamento([{ status: "em_pagamento", valorFinal: 200, valorDevolvido: 50 }]);
    expect(resultado.faturamentoBruto).toBe(200);
    expect(resultado.faturamentoLiquido).toBe(150);
  });

  it("devolução integral (todo o valor devolvido, sem a venda estar cancelada): bruto = valorFinal, líquido = 0", () => {
    const resultado = calcularFaturamento([{ status: "concluida", valorFinal: 200, valorDevolvido: 200 }]);
    expect(resultado.faturamentoBruto).toBe(200);
    expect(resultado.faturamentoLiquido).toBe(0);
  });

  it("venda cancelada não entra em nenhum dos dois indicadores", () => {
    const resultado = calcularFaturamento([{ status: "cancelada", valorFinal: 200, valorDevolvido: 0 }]);
    expect(resultado.faturamentoBruto).toBe(0);
    expect(resultado.faturamentoLiquido).toBe(0);
  });

  it("combinação de várias vendas: soma bruto/líquido corretamente e ignora as canceladas", () => {
    const resultado = calcularFaturamento([
      { status: "concluida", valorFinal: 100, valorDevolvido: 0 }, // bruto 100, líquido 100
      { status: "em_pagamento", valorFinal: 200, valorDevolvido: 50 }, // bruto 200, líquido 150
      { status: "concluida", valorFinal: 200, valorDevolvido: 200 }, // bruto 200, líquido 0
      { status: "cancelada", valorFinal: 999, valorDevolvido: 0 }, // excluída inteiramente
    ]);
    expect(resultado.faturamentoBruto).toBe(500);
    expect(resultado.faturamentoLiquido).toBe(250);
  });

  it("valorDevolvido ausente/null/zero é tratado como zero", () => {
    const semCampo = calcularFaturamento([{ status: "concluida", valorFinal: 80 }]);
    const nulo = calcularFaturamento([{ status: "concluida", valorFinal: 80, valorDevolvido: null }]);
    const zero = calcularFaturamento([{ status: "concluida", valorFinal: 80, valorDevolvido: 0 }]);
    expect(semCampo).toEqual({ faturamentoBruto: 80, faturamentoLiquido: 80 });
    expect(nulo).toEqual({ faturamentoBruto: 80, faturamentoLiquido: 80 });
    expect(zero).toEqual({ faturamentoBruto: 80, faturamentoLiquido: 80 });
  });

  it("nunca produz líquido negativo por uma inconsistência de dados (valorDevolvido > valorFinal)", () => {
    const resultado = calcularFaturamento([{ status: "concluida", valorFinal: 100, valorDevolvido: 150 }]);
    expect(resultado.faturamentoBruto).toBe(100);
    expect(resultado.faturamentoLiquido).toBe(0);
  });

  it("conjunto vazio devolve zero para os dois, sem dividir por zero em nenhum lugar", () => {
    expect(calcularFaturamento([])).toEqual({ faturamentoBruto: 0, faturamentoLiquido: 0 });
  });

  it("arredondamento monetário: soma flutuante de centavos fecha em 2 casas", () => {
    const resultado = calcularFaturamento([
      { status: "concluida", valorFinal: 10.1, valorDevolvido: 0 },
      { status: "concluida", valorFinal: 10.2, valorDevolvido: 0 },
    ]);
    expect(resultado.faturamentoBruto).toBe(20.3);
    expect(resultado.faturamentoLiquido).toBe(20.3);
  });
});
