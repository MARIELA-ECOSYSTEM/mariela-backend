import { describe, expect, it } from "bun:test";
import {
  calcularMesAnterior,
  calcularMesesDisponiveis,
  chaveMes,
  diasNoMes,
  labelMes,
  limitesDaSemana,
  limitesDeHoje,
  limitesDoMes,
  resolverMesReferencia,
  somarValorFinal,
} from "./dashboard.util.js";

describe("chaveMes / labelMes", () => {
  it("formata a chave YYYY-MM com o mês com 2 dígitos", () => {
    expect(chaveMes(new Date(2026, 0, 15))).toBe("2026-01");
    expect(chaveMes(new Date(2026, 10, 1))).toBe("2026-11");
  });

  it("gera o rótulo por extenso em pt-BR", () => {
    expect(labelMes("2026-08")).toMatch(/agosto/i);
    expect(labelMes("2026-08")).toMatch(/2026/);
  });
});

describe("calcularMesesDisponiveis", () => {
  it("retorna 6 meses, do atual para trás, sem repetição", () => {
    const referencia = new Date(2026, 7, 20); // 2026-08-20
    const meses = calcularMesesDisponiveis(referencia);
    expect(meses).toHaveLength(6);
    expect(meses.map((m) => m.valor)).toEqual(["2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03"]);
  });

  it("atravessa a virada de ano corretamente", () => {
    const referencia = new Date(2026, 1, 10); // 2026-02-10
    const meses = calcularMesesDisponiveis(referencia);
    expect(meses.map((m) => m.valor)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11", "2025-10", "2025-09"]);
  });
});

describe("calcularMesAnterior", () => {
  it("retorna o mês anterior dentro do mesmo ano", () => {
    expect(calcularMesAnterior("2026-08")).toBe("2026-07");
  });

  it("atravessa a virada de ano", () => {
    expect(calcularMesAnterior("2026-01")).toBe("2025-12");
  });
});

describe("resolverMesReferencia", () => {
  const disponiveis = calcularMesesDisponiveis(new Date(2026, 7, 20));

  it("usa o mes solicitado quando está entre os disponíveis", () => {
    expect(resolverMesReferencia("2026-06", disponiveis)).toBe("2026-06");
  });

  it("cai no mês atual (primeiro disponível) quando o solicitado está fora do intervalo", () => {
    expect(resolverMesReferencia("1999-01", disponiveis)).toBe(disponiveis[0]!.valor);
  });

  it("cai no mês atual quando nada é solicitado", () => {
    expect(resolverMesReferencia(undefined, disponiveis)).toBe(disponiveis[0]!.valor);
  });
});

describe("limitesDoMes", () => {
  it("gera um intervalo semiaberto [início do mês, início do mês seguinte)", () => {
    const { inicio, fim } = limitesDoMes("2026-02");
    expect(inicio).toEqual(new Date(2026, 1, 1, 0, 0, 0, 0));
    expect(fim).toEqual(new Date(2026, 2, 1, 0, 0, 0, 0));
  });

  it("dezembro vira janeiro do ano seguinte no limite superior", () => {
    const { fim } = limitesDoMes("2026-12");
    expect(fim).toEqual(new Date(2027, 0, 1, 0, 0, 0, 0));
  });
});

describe("limitesDeHoje / limitesDaSemana", () => {
  it("hoje é um intervalo de exatamente 24h começando à meia-noite", () => {
    const agora = new Date(2026, 7, 20, 15, 30, 0);
    const { inicio, fim } = limitesDeHoje(agora);
    expect(inicio).toEqual(new Date(2026, 7, 20, 0, 0, 0, 0));
    expect(fim.getTime() - inicio.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("semana cobre exatamente 7 dias terminando amanhã à meia-noite (hoje incluso)", () => {
    const agora = new Date(2026, 7, 20, 15, 30, 0);
    const { inicio, fim } = limitesDaSemana(agora);
    expect(fim).toEqual(new Date(2026, 7, 21, 0, 0, 0, 0));
    expect(inicio).toEqual(new Date(2026, 7, 14, 0, 0, 0, 0));
    expect(fim.getTime() - inicio.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("somarValorFinal", () => {
  it("soma e arredonda para 2 casas decimais", () => {
    expect(somarValorFinal([{ valorFinal: 10.1 }, { valorFinal: 20.25 }, { valorFinal: 0.005 }])).toBeCloseTo(30.36, 2);
  });

  it("retorna 0 para lista vazia (nunca divide por zero em cálculos posteriores)", () => {
    expect(somarValorFinal([])).toBe(0);
  });
});

describe("diasNoMes", () => {
  it("fevereiro de ano bissexto tem 29 dias", () => {
    expect(diasNoMes("2028-02")).toBe(29);
  });

  it("fevereiro de ano não bissexto tem 28 dias", () => {
    expect(diasNoMes("2026-02")).toBe(28);
  });

  it("meses de 31 dias", () => {
    expect(diasNoMes("2026-01")).toBe(31);
  });
});
