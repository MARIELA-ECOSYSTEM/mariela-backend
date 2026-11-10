import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acrescentarAncora, ARQUIVO_REAL, caminhoAncora, criarAncora, estadosAdmitidos, gravarDuravel, lerCadeia, proximaLinha, type EventoAncora, type OperacoesArquivo } from "./ancora.js";

/**
 * Fase 60.4.3.4.21.2.11 (N2) — durabilidade da âncora. Injeção de falha em cada etapa da escrita (abrir, escrever, fsync,
 * fechar, fsync do diretório) + arquivos REAIS numa pasta temporária própria (removida ao final; nunca a raiz persistente).
 * NÃO provado aqui (não testável sem hardware/SO controlado): queda de energia real, cache de escrita volátil do disco.
 */

const base = { banco: "mariela_restore_20260101_000001", execucaoId: "e1", instanciaId: "i1" };
const posse: EventoAncora = { ...base, evento: "POSSE", archive: { caminho: "a", sha256: "A".repeat(64) }, manifesto: { caminho: "m", sha256: "B".repeat(64) } };
const intencao: EventoAncora = { ...base, evento: "INTENCAO", de: "PREPARANDO", para: "RESTAURANDO" };
const confirmacao: EventoAncora = { ...base, evento: "CONFIRMACAO", de: "PREPARANDO", para: "RESTAURANDO" };

let raiz = "";
beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), "mariela-n2-"));
});
afterEach(() => {
  if (raiz && raiz.includes("mariela-n2-")) rmSync(raiz, { recursive: true, force: true });
});

/** fs real com registro da ordem das chamadas e falha programável numa etapa. */
function instrumentado(falharEm?: keyof OperacoesArquivo, modo: "erro" | "parcial" = "erro") {
  const chamadas: string[] = [];
  const fs: OperacoesArquivo = {
    abrir: (c, f) => {
      chamadas.push("abrir");
      if (falharEm === "abrir") throw new Error("EACCES simulado");
      return ARQUIVO_REAL.abrir(c, f);
    },
    escrever: (fd, d) => {
      chamadas.push("escrever");
      if (falharEm === "escrever") {
        if (modo === "parcial") ARQUIVO_REAL.escrever(fd, d.subarray(0, Math.floor(d.length / 2)));
        throw new Error("ENOSPC simulado");
      }
      ARQUIVO_REAL.escrever(fd, d);
    },
    sincronizar: (fd) => {
      chamadas.push("sincronizar");
      if (falharEm === "sincronizar") throw new Error("EIO simulado no fsync");
      ARQUIVO_REAL.sincronizar(fd);
    },
    fechar: (fd) => {
      chamadas.push("fechar");
      ARQUIVO_REAL.fechar(fd);
      if (falharEm === "fechar") throw new Error("EIO simulado no close");
    },
    sincronizarDiretorio: (d) => {
      chamadas.push("sincronizarDiretorio");
      if (falharEm === "sincronizarDiretorio") throw new Error("EIO simulado no fsync do diretório");
      ARQUIVO_REAL.sincronizarDiretorio(d);
    },
  };
  return { fs, chamadas };
}

const ler = () => readFileSync(caminhoAncora(raiz, base.banco, base.execucaoId), "utf8");

describe("N2 — escrita durável: ordem e falhas", () => {
  it("ordem: abrir → escrever → fsync → fechar → fsync do diretório", () => {
    const { fs, chamadas } = instrumentado();
    criarAncora(raiz, posse, fs);
    expect(chamadas).toEqual(["abrir", "escrever", "sincronizar", "fechar", "sincronizarDiretorio"]);
    expect(lerCadeia(ler()).ok).toBe(true);
  });
  it("falha ANTES da escrita (abrir) ⇒ erro propagado, nada criado", () => {
    const { fs, chamadas } = instrumentado("abrir");
    expect(() => criarAncora(raiz, posse, fs)).toThrow("EACCES");
    expect(chamadas).toEqual(["abrir"]);
    expect(() => ler()).toThrow();
  });
  it("falha DURANTE a escrita (parcial) ⇒ erro propagado, fd fechado, registro INCOMPLETO detectado e acréscimo recusado", () => {
    criarAncora(raiz, posse);
    const { fs, chamadas } = instrumentado("escrever", "parcial");
    expect(() => acrescentarAncora(raiz, intencao, fs)).toThrow("ENOSPC");
    expect(chamadas).toEqual(["abrir", "escrever", "fechar"]);
    const c = lerCadeia(ler());
    expect(c.ok).toBe(false);
    expect(c.motivo).toContain("INCOMPLETO");
    expect(() => acrescentarAncora(raiz, intencao)).toThrow("inválido");
  });
  it("falha no FSYNC ⇒ erro propagado (o chamador não faz o CAS), fd fechado; a intenção escrita só admite de/para", () => {
    criarAncora(raiz, posse);
    const { fs, chamadas } = instrumentado("sincronizar");
    expect(() => acrescentarAncora(raiz, intencao, fs)).toThrow("fsync");
    expect(chamadas).toEqual(["abrir", "escrever", "sincronizar", "fechar"]);
    const c = lerCadeia(ler());
    expect(c.ok).toBe(true);
    expect(estadosAdmitidos(c.entradas)).toEqual(["PREPARANDO", "RESTAURANDO"]); // banco continua no `de`: admitido
  });
  it("falha no FECHAMENTO ⇒ erro propagado; fsync já feito", () => {
    criarAncora(raiz, posse);
    const { fs, chamadas } = instrumentado("fechar");
    expect(() => acrescentarAncora(raiz, intencao, fs)).toThrow("close");
    expect(chamadas).toEqual(["abrir", "escrever", "sincronizar", "fechar"]);
  });
  it("falha no fsync do DIRETÓRIO ⇒ erro propagado", () => {
    const { fs } = instrumentado("sincronizarDiretorio");
    expect(() => criarAncora(raiz, posse, fs)).toThrow("diretório");
  });
  it("erro de escrita E de fechamento ⇒ o PRIMEIRO erro é o propagado", () => {
    const fs: OperacoesArquivo = { ...ARQUIVO_REAL, escrever: () => { throw new Error("primeiro"); }, fechar: (fd) => { ARQUIVO_REAL.fechar(fd); throw new Error("segundo"); } };
    expect(() => gravarDuravel(join(raiz, "x.txt"), "a\n", "wx", fs)).toThrow("primeiro");
  });
  it("criarAncora nunca reaproveita um registro (wx)", () => {
    criarAncora(raiz, posse);
    expect(() => criarAncora(raiz, posse)).toThrow();
  });
});

describe("N2 — formato: encoding, terminadores e cadeia preservada", () => {
  it("UTF-8 sem BOM, LF, cada linha terminada; cadeia íntegra após acréscimos (com acentos)", () => {
    criarAncora(raiz, posse);
    acrescentarAncora(raiz, { ...intencao, detalhe: "restauração — ação" });
    acrescentarAncora(raiz, confirmacao);
    const bruto = readFileSync(caminhoAncora(raiz, base.banco, base.execucaoId));
    expect(bruto[0]).not.toBe(0xef);
    const t = bruto.toString("utf8");
    expect(t.includes("\r")).toBe(false);
    expect(t.endsWith("\n")).toBe(true);
    const c = lerCadeia(t);
    expect(c.ok).toBe(true);
    expect(c.entradas.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(c.entradas[1]!.detalhe).toBe("restauração — ação");
  });
  it("registro regravado com CRLF ⇒ inválido (motivo explícito)", () => {
    criarAncora(raiz, posse);
    const c = caminhoAncora(raiz, base.banco, base.execucaoId);
    writeFileSync(c, ler().replace(/\n/g, "\r\n"));
    expect(lerCadeia(ler()).motivo).toContain("CR");
    expect(() => acrescentarAncora(raiz, intencao)).toThrow("inválido");
  });
  it("registro regravado com BOM ⇒ inválido", () => {
    criarAncora(raiz, posse);
    writeFileSync(caminhoAncora(raiz, base.banco, base.execucaoId), `﻿${ler()}`);
    expect(lerCadeia(ler()).motivo).toContain("BOM");
  });
  it("última linha completa mas SEM terminador ⇒ incompleto (falha fechada)", () => {
    const t = `${proximaLinha("", posse)}`;
    expect(lerCadeia(t).ok).toBe(false);
    expect(lerCadeia(`${t}\n`).ok).toBe(true);
  });
  it("registro vazio ⇒ inválido; acréscimo sem registro ⇒ recusado", () => {
    expect(lerCadeia("").ok).toBe(false);
    expect(() => acrescentarAncora(raiz, intencao)).toThrow("ausente");
  });
});
