import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETENCAO } from "./politica.js";
import { aplicarRetencao, listarBackups, planejarRetencao, semanaIso, type EntradaBackup } from "./retencao.js";

/** Fase 60.4.3.4.21.2 — retenção 14/8/12 + 5 extraordinários + inválidos 7 dias + piso de 2 válidos. */

const AGORA = new Date("2026-11-09T23:50:00-03:00");

function dia(offset: number): string {
  const d = new Date(Date.UTC(2026, 10, 9));
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}
function diario(offset: number, hhmmss = "234500"): EntradaBackup {
  const data = dia(offset);
  return { base: `mariela_prod_${data.replace(/-/g, "")}_${hhmmss}`, classe: "diario", dataLocal: data, instante: `${data}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4)}-03:00` };
}
function extra(offset: number): EntradaBackup {
  const data = dia(offset);
  return { base: `mariela_extra_${data.replace(/-/g, "")}_120000`, classe: "extraordinario", dataLocal: data, instante: `${data}T12:00:00-03:00` };
}
function invalido(offset: number): EntradaBackup {
  const data = dia(offset);
  return { base: `mariela_invalido_${data.replace(/-/g, "")}_235000`, classe: "invalido", dataLocal: data, instante: `${data}T23:50:00-03:00` };
}
const mantidos = (d: ReturnType<typeof planejarRetencao>) => new Set(d.manter.map((m) => m.base));

describe("semanaIso", () => {
  it("semanas ISO-8601, inclusive virada de ano", () => {
    expect(semanaIso("2026-11-09")).toBe("2026-W46");
    expect(semanaIso("2021-01-03")).toBe("2020-W53");
    expect(semanaIso("2024-12-30")).toBe("2025-W01");
  });
});

describe("planejarRetencao", () => {
  it("400 dias de diários: mantém 14 dias + 1 por semana (8) + 1 por mês (12), sem dupla contagem; nunca remove a mais nova", () => {
    const entradas = Array.from({ length: 400 }, (_, i) => diario(i));
    const d = planejarRetencao(entradas, { agora: AGORA, novoValidoBase: entradas[0]!.base });
    const m = mantidos(d);
    for (let i = 0; i < 14; i += 1) expect(m.has(entradas[i]!.base)).toBe(true);
    const semanas = new Set([...m].map((b) => semanaIso(entradas.find((e) => e.base === b)!.dataLocal)));
    const meses = new Set([...m].map((b) => entradas.find((e) => e.base === b)!.dataLocal.slice(0, 7)));
    expect(semanas.size).toBeGreaterThanOrEqual(8);
    expect(meses.size).toBe(12);
    // união: 14 diários (≈ 2–3 semanas já cobertas) + semanas restantes + meses restantes — no máximo 34
    expect(m.size).toBeLessThanOrEqual(14 + 8 + 12);
    expect(m.size).toBe(d.manter.length);
    expect(d.manter.length + d.remover.length).toBe(400);
    // cada mantida é a mais recente do seu período em algum conjunto
    for (const r of d.remover) expect(r.motivo).toContain("fora das vagas");
  });

  it("dois diários no mesmo dia: só o mais recente ocupa a vaga do dia", () => {
    const entradas = [diario(0, "235900"), diario(0, "234500"), diario(1)];
    const d = planejarRetencao(entradas, { agora: AGORA, novoValidoBase: entradas[0]!.base });
    expect(mantidos(d).has(entradas[1]!.base)).toBe(false);
    expect(mantidos(d).has(entradas[0]!.base)).toBe(true);
  });

  it("sem novo backup válido confirmado → NÃO executa (falha fechada), nada é removido", () => {
    const entradas = [...Array.from({ length: 30 }, (_, i) => diario(i)), invalido(30)];
    for (const novo of [null, "inexistente", invalido(30).base]) {
      const d = planejarRetencao(entradas, { agora: AGORA, novoValidoBase: novo });
      expect(d.executada).toBe(false);
      expect(d.remover).toEqual([]);
    }
  });

  it("extraordinários: mantém os 5 mais recentes, fora da rotação diária", () => {
    const extras = Array.from({ length: 8 }, (_, i) => extra(i * 3));
    const entradas = [diario(0), ...extras];
    const d = planejarRetencao(entradas, { agora: AGORA, novoValidoBase: entradas[0]!.base });
    const m = mantidos(d);
    expect(extras.filter((e) => m.has(e.base))).toEqual(extras.slice(0, 5));
    expect(d.remover.map((r) => r.base).sort()).toEqual(extras.slice(5).map((e) => e.base).sort());
  });

  it("inválidos: removidos só depois de 7 dias", () => {
    const entradas = [diario(0), invalido(6), invalido(8)];
    const d = planejarRetencao(entradas, { agora: AGORA, novoValidoBase: entradas[0]!.base });
    expect(mantidos(d).has(invalido(6).base)).toBe(true);
    expect(d.remover.map((r) => r.base)).toEqual([invalido(8).base]);
  });

  it("piso de 2 cópias válidas prevalece sobre as vagas", () => {
    const entradas = [diario(0), diario(1), diario(2)];
    const politica = { ...RETENCAO, diarios: 1, semanais: 0, mensais: 0 } as unknown as typeof RETENCAO;
    const d = planejarRetencao(entradas, { agora: AGORA, novoValidoBase: entradas[0]!.base, politica });
    expect([...mantidos(d)].sort()).toEqual([entradas[0]!.base, entradas[1]!.base].sort());
    expect(d.manter.find((m) => m.base === entradas[1]!.base)?.motivos.join()).toContain("piso");
  });

  it("legado e conflito nunca são removidos", () => {
    const entradas: EntradaBackup[] = [
      diario(0),
      { base: "mariela_prod_20260921_1357", classe: "legado", dataLocal: "2026-09-21", instante: "2026-09-21T00:00:00" },
      { base: "mariela_prod_20250101_234500", classe: "conflito", dataLocal: "2025-01-01", instante: "2025-01-01T23:45:00-03:00" },
    ];
    const d = planejarRetencao(entradas, { agora: AGORA, novoValidoBase: entradas[0]!.base });
    expect(d.remover).toEqual([]);
  });
});

describe("listarBackups + aplicarRetencao (diretório real)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function criar(base: string, manifesto: object | null, comArchive = true) {
    if (comArchive) writeFileSync(join(dir, `${base}.archive.gz`), "x");
    writeFileSync(join(dir, `${base}.archive.gz.sha256`), "x");
    if (manifesto) writeFileSync(join(dir, `${base}.manifest.json`), JSON.stringify(manifesto));
  }

  it("classifica pelo MANIFESTO, preserva legado/fora do padrão/pastas e apaga só artefatos conhecidos", () => {
    dir = mkdtempSync(join(tmpdir(), "retencao-"));
    for (let i = 0; i < 16; i += 1) {
      const e = diario(i);
      criar(e.base, { estado: "VALIDO_LOCAL", tipo: "diario", dataLocal: e.dataLocal, iniciadoEm: e.instante });
    }
    criar("mariela_invalido_20261020_235000", { estado: "INVALIDO", tipo: "diario", dataLocal: "2026-10-20", iniciadoEm: "2026-10-20T23:50:00-03:00" }, false);
    criar("mariela_prod_20261021_234500", { estado: "INVALIDO", tipo: "diario", dataLocal: "2026-10-21", iniciadoEm: "2026-10-21T23:45:00-03:00" }); // prefixo válido + manifesto inválido = conflito
    writeFileSync(join(dir, "mariela_prod_20260921_1357.archive.gz"), "legado");
    writeFileSync(join(dir, "anotacoes.txt"), "não mexer");
    mkdirSync(join(dir, "mariela_prod_20200101_000000.archive.gz"));

    const entradas = listarBackups(dir);
    expect(entradas.find((e) => e.base === "mariela_prod_20260921_1357")?.classe).toBe("legado");
    expect(entradas.find((e) => e.base === "mariela_prod_20261021_234500")?.classe).toBe("conflito");
    expect(entradas.find((e) => e.base === "mariela_invalido_20261020_235000")?.classe).toBe("invalido");

    const novo = diario(0).base;
    const decisao = planejarRetencao(entradas, { agora: AGORA, novoValidoBase: novo });
    const apagados = aplicarRetencao(dir, decisao);
    const restantes = readdirSync(dir);
    expect(restantes).toContain("mariela_prod_20260921_1357.archive.gz");
    expect(restantes).toContain("anotacoes.txt");
    expect(restantes).toContain("mariela_prod_20200101_000000.archive.gz"); // pasta, nunca tocada
    expect(restantes).toContain("mariela_prod_20261021_234500.manifest.json");
    expect(existsSync(join(dir, `${novo}.archive.gz`))).toBe(true);
    expect(apagados.some((a) => a.startsWith("mariela_invalido_20261020_235000"))).toBe(true);
    for (const a of apagados) expect(a).toMatch(/^mariela_(prod|extra|invalido)_\d{8}_\d{6}\./);
  });
});
