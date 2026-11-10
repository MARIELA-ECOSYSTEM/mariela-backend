import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Int32, Long, ObjectId } from "bson";
import { ArchiveInvalidoErro, idsDoArchive } from "./archive.js";
import { chaveDoId, COLECAO_POSSE } from "./posse.js";
import { RESTORE } from "./politica.js";
import { montarArchive } from "./teste-archive.util.js";
import { caminhoTrava, inicioDoProcesso, verificarTrava } from "./trava.js";

/**
 * Fase 60.4.3.4.21.2.4 (R21-2.3-01) — testes unitários (sem MongoDB) da prova de conteúdo e da verificação da trava.
 * A concorrência real (dois processos + MongoDB descartável) fica em testes/testes-posse.ps1.
 */

describe("chave do _id: archive × banco", () => {
  const oid = new ObjectId("65a1b2c3d4e5f60718293a4b");
  const archive = montarArchive({
    colecoes: [
      { db: "marielaDB", colecao: "produtos", docs: [{ _id: oid, a: 1 }, { _id: "PRD-001", a: 2 }, { _id: new Int32(7) }, { _id: Long.fromNumber(8) }] },
      { db: "marielaDB", colecao: "vazia", docs: [] },
    ],
  });

  it("a chave extraída do archive é a mesma de chaveDoId para o mesmo _id (ObjectId, string, Int32, Long)", () => {
    const ids = idsDoArchive(archive);
    const produtos = ids.get("marielaDB.produtos")!;
    expect(produtos.size).toBe(4);
    for (const id of [oid, "PRD-001", new Int32(7), Long.fromNumber(8)]) expect(produtos.has(chaveDoId(id))).toBe(true);
    expect(ids.get("marielaDB.vazia")?.size ?? 0).toBe(0);
  });

  it("tipos diferentes com o 'mesmo valor' NÃO colidem (Int32 7 ≠ string '7' ≠ Long 7)", () => {
    const ch = new Set([chaveDoId(new Int32(7)), chaveDoId("7"), chaveDoId(Long.fromNumber(7))]);
    expect(ch.size).toBe(3);
  });

  it("documento cujo primeiro campo não é _id ⇒ archive recusado (falha fechada)", () => {
    const ruim = montarArchive({ colecoes: [{ db: "marielaDB", colecao: "produtos", docs: [{ a: 1, _id: "x" }] }] });
    expect(() => idsDoArchive(ruim)).toThrow(ArchiveInvalidoErro);
  });

  it("a coleção de controle tem nome reservado, fora da política", () => {
    expect(COLECAO_POSSE).toBe(RESTORE.colecaoPosse);
    expect(COLECAO_POSSE.startsWith("_mariela_restore_")).toBe(true);
  });
});

describe("verificarTrava (sem processo segurando a trava)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mariela-trava-"));
  const arq = caminhoTrava(dir);

  it("caminho da trava fica sob <raiz>/locks", () => {
    expect(arq).toBe(join(dir, "locks", "restore.lock"));
  });

  it("trava inexistente ⇒ nada comprovado", () => {
    expect(verificarTrava(arq, "e", 1).every((v) => !v.ok)).toBe(true);
  });

  it("arquivo LIVRE (ninguém o mantém aberto) ⇒ trava.segura falha mesmo com conteúdo correto", () => {
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(arq, JSON.stringify({ execucaoId: "e1", pid: 42 }));
    const v = verificarTrava(arq, "e1", 42);
    expect(v.find((x) => x.id === "trava.segura")!.ok).toBe(false);
    expect(v.find((x) => x.id === "trava.execucao")!.ok).toBe(true);
    expect(v.find((x) => x.id === "trava.dono")!.ok).toBe(true);
  });

  it("conteúdo de OUTRA execução, de outro pid ou marcado livre ⇒ recusado", () => {
    writeFileSync(arq, JSON.stringify({ execucaoId: "e2", pid: 42 }));
    expect(verificarTrava(arq, "e1", 42).find((x) => x.id === "trava.execucao")!.ok).toBe(false);
    writeFileSync(arq, JSON.stringify({ execucaoId: "e1", pid: 43 }));
    expect(verificarTrava(arq, "e1", 42).find((x) => x.id === "trava.dono")!.ok).toBe(false);
    writeFileSync(arq, JSON.stringify({ livre: true, execucaoId: "e1", pid: 42 }));
    expect(verificarTrava(arq, "e1", 42).find((x) => x.id === "trava.execucao")!.ok).toBe(false);
  });

  it("A-09: horário de criação do dono — igual ⇒ ok; diferente (PID reutilizado), ausente ou ilegível ⇒ recusado", () => {
    writeFileSync(arq, JSON.stringify({ execucaoId: "e1", pid: 42, processoInicioTicks: "134387417609834328" }));
    const inicio = (v: ReturnType<typeof verificarTrava>) => v.find((x) => x.id === "trava.dono_inicio")!.ok;
    expect(inicio(verificarTrava(arq, "e1", 42, 134387417609834328n))).toBe(true);
    expect(inicio(verificarTrava(arq, "e1", 42, 134387417609834329n))).toBe(false);
    expect(inicio(verificarTrava(arq, "e1", 42, null))).toBe(false);
    writeFileSync(arq, JSON.stringify({ execucaoId: "e1", pid: 42 }));
    expect(inicio(verificarTrava(arq, "e1", 42, 134387417609834328n))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("inicioDoProcesso (GetProcessTimes)", () => {
  it.skipIf(process.platform !== "win32")("lê o horário de criação do próprio processo e devolve null para PID inexistente", () => {
    const meu = inicioDoProcesso(process.pid);
    expect(typeof meu).toBe("bigint");
    expect(meu! > 0n).toBe(true);
    expect(inicioDoProcesso(process.pid)).toBe(meu);
    expect(inicioDoProcesso(0)).toBeNull();
    expect(inicioDoProcesso(4_294_967_000)).toBeNull();
  });
  it("fora do Windows (CI): sempre null — a verificação da trava falha fechada", () => {
    if (process.platform !== "win32") expect(inicioDoProcesso(process.pid)).toBeNull();
  });
});
