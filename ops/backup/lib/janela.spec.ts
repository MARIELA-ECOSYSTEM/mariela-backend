import { describe, expect, it } from "bun:test";
import { avaliarDevido, compararAssinaturas, ultimoMarcoDaJanela, verificarPeriodoSemEscrita, type Assinatura } from "./janela.js";

/** Fase 60.4.3.4.21.2 — decisões puras da janela (23:45, 15 min sem escrita, retomada após ligar o computador). */

const local = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m, 0, 0); // novembro/2026, hora LOCAL

describe("horário-alvo e retomada", () => {
  it("o marco é o último 23:45 que já passou", () => {
    expect(ultimoMarcoDaJanela(local(9, 23, 50), 23, 45).getTime()).toBe(local(9, 23, 45).getTime());
    expect(ultimoMarcoDaJanela(local(10, 9, 0), 23, 45).getTime()).toBe(local(9, 23, 45).getTime());
    expect(ultimoMarcoDaJanela(local(9, 23, 45), 23, 45).getTime()).toBe(local(9, 23, 45).getTime());
  });

  it("23:50 sem backup do dia → devido", () => {
    expect(avaliarDevido(local(9, 23, 50), local(8, 23, 46), 23, 45).devido).toBe(true);
  });

  it("já existe diário válido depois do marco → JA_REALIZADO (não repete)", () => {
    const r = avaliarDevido(local(9, 23, 59), local(9, 23, 46), 23, 45);
    expect(r.devido).toBe(false);
    expect(r.motivo).toContain("JA_REALIZADO");
  });

  it("RETOMADA: computador ligado às 09:00 do dia seguinte sem o backup da noite → continua devido (e só coleta se a janela passar)", () => {
    expect(avaliarDevido(local(10, 9, 0), local(8, 23, 50), 23, 45).devido).toBe(true);
  });

  it("antes das 23:45 com o backup da noite anterior feito → não devido", () => {
    expect(avaliarDevido(local(10, 22, 0), local(9, 23, 50), 23, 45).devido).toBe(false);
  });

  it("primeiro backup da história (nenhum anterior) → devido", () => {
    expect(avaliarDevido(local(10, 1, 0), null, 23, 45).devido).toBe(true);
  });
});

describe("período sem escrita (15 min)", () => {
  const agora = new Date("2026-11-09T23:50:00-03:00");
  const ass = (minutosAtras: number | null): Assinatura => ({
    vendas: { contagem: 1, maiorTimestamp: minutosAtras === null ? null : new Date(agora.getTime() - minutosAtras * 60_000).toISOString(), hashConteudo: null },
  });

  it("escrita há 14 min → ADIA; há 16 min → OK", () => {
    expect(verificarPeriodoSemEscrita(ass(14), agora, 15).ok).toBe(false);
    expect(verificarPeriodoSemEscrita(ass(16), agora, 15).ok).toBe(true);
  });

  it("exatamente no limite (15 min) → OK; timestamp no FUTURO (relógio adiantado) → ADIA", () => {
    expect(verificarPeriodoSemEscrita(ass(15), agora, 15).ok).toBe(true);
    expect(verificarPeriodoSemEscrita(ass(-5), agora, 15).ok).toBe(false);
  });

  it("coleções sem timestamp não bloqueiam (a mudança delas é pega pelo hash antes/depois)", () => {
    expect(verificarPeriodoSemEscrita(ass(null), agora, 15).ok).toBe(true);
  });
});

describe("assinaturas antes/depois", () => {
  const base: Assinatura = { vendas: { contagem: 2, maiorTimestamp: "2026-11-09T20:00:00.000Z", hashConteudo: null }, sequencias: { contagem: 3, maiorTimestamp: null, hashConteudo: "AB" } };

  it("iguais → sem escrita detectada", () => {
    expect(compararAssinaturas(base, structuredClone(base))).toEqual({ iguais: true, divergentes: [] });
  });

  it("contagem, timestamp (update sem mudar contagem) ou hash diferentes → divergência apontada por coleção", () => {
    expect(compararAssinaturas(base, { ...base, vendas: { ...base.vendas!, contagem: 3 } }).divergentes).toEqual(["vendas"]);
    expect(compararAssinaturas(base, { ...base, vendas: { ...base.vendas!, maiorTimestamp: "2026-11-09T21:00:00.000Z" } }).divergentes).toEqual(["vendas"]);
    expect(compararAssinaturas(base, { ...base, sequencias: { ...base.sequencias!, hashConteudo: "CD" } }).divergentes).toEqual(["sequencias"]);
  });
});
