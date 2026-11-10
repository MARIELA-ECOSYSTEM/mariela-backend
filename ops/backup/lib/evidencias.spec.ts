import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { conferirDestino, conferirPacote, criarPacoteEvidencias, sanitizarTexto } from "./evidencias.js";

/**
 * Fase 60.4.3.4.21.2.11 (N5) — pacote de evidências com conteúdo SINTÉTICO, numa pasta temporária própria (removida
 * ao final). Nada é enviado a lugar nenhum.
 */

const REPO = resolve(import.meta.dir, "..", "..", "..");
const SENHA_FICTICIA = "senha-ficticia-N5-teste-0001";
let tmp = "";
let origem = "";
let raizIso = "";
let destino = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mariela-n5-"));
  origem = join(tmp, "runner");
  raizIso = join(tmp, "raiz-isolada");
  destino = join(tmp, "pacotes");
  mkdirSync(join(origem, "relatorios"), { recursive: true });
  mkdirSync(join(origem, "evidencias"), { recursive: true });
  mkdirSync(join(origem, "seguranca"), { recursive: true });
  mkdirSync(raizIso, { recursive: true });
  writeFileSync(join(origem, "relatorios", "restore_x.json"), JSON.stringify({ resultado: "PASSOU", uri: "mongodb://usuario:senha@127.0.0.1:27118/?x=1", senha: SENHA_FICTICIA }));
  writeFileSync(join(origem, "evidencias", "b__e.jsonl"), '{"seq":1,"evento":"POSSE"}\n');
  writeFileSync(join(origem, "log.txt"), `linha com ${SENHA_FICTICIA} e Authorization: Bearer abcdefghijklmnop e token=xyz123`);
  writeFileSync(join(origem, "seguranca", "admin.cred"), "usuario\nBLOB");
  writeFileSync(join(origem, "mongod.key"), "CHAVE");
  writeFileSync(join(origem, ".env"), "MONGO_URI=x");
  writeFileSync(join(origem, "dump.archive.gz"), Buffer.from([1, 2, 3]));
});
afterEach(() => {
  if (tmp.includes("mariela-n5-")) rmSync(tmp, { recursive: true, force: true });
});

const resultados = [
  { id: "T01a", caso: "dois restores", resultado: "PASSOU" },
  { id: "T06c", caso: "recuperar", resultado: "FALHOU", detalhe: `motivo ${SENHA_FICTICIA}` },
];
const criar = (mud: Partial<Parameters<typeof criarPacoteEvidencias>[0]> = {}) =>
  criarPacoteEvidencias({ destino, origens: [origem], resultados, repositorio: REPO, raizIsolada: raizIso, segredos: [SENHA_FICTICIA], agora: new Date("2026-11-10T12:00:00Z"), ...mud });

describe("N5 — pacote de evidências", () => {
  it("cria pacote com id único, índice, resultados por caso, arquivos sanitizados e manifesto SHA-256 conferível", () => {
    const r = criar();
    expect(r.pasta.startsWith(destino)).toBe(true);
    expect(r.id).toMatch(/^20261110T120000Z_[0-9a-f]{8}$/);
    const indice = JSON.parse(readFileSync(join(r.pasta, "indice.json"), "utf8"));
    expect(indice.casos).toBe(2);
    expect(indice.resumo).toEqual({ PASSOU: 1, FALHOU: 1 });
    expect(JSON.parse(readFileSync(join(r.pasta, "resultados.json"), "utf8"))).toHaveLength(2);
    expect(conferirPacote(r.pasta)).toEqual({ ok: true, problemas: [] });
    const nomes = r.arquivos.map((a) => a.caminho).sort();
    expect(nomes).toEqual(["arquivos/runner/evidencias/b__e.jsonl", "arquivos/runner/log.txt", "arquivos/runner/relatorios/restore_x.json", "indice.json", "resultados.json"]);
  });
  it("NUNCA inclui credencial, chave, .env, pasta seguranca ou binário — e registra a exclusão", () => {
    const r = criar();
    const motivos = r.excluidos.map((e) => `${e.origem.split(/[\\/]/).pop()}:${e.motivo}`);
    expect(motivos.some((m) => m.startsWith("seguranca:"))).toBe(true);
    expect(motivos.some((m) => m.startsWith("mongod.key:"))).toBe(true);
    expect(motivos.some((m) => m.startsWith(".env:"))).toBe(true);
    expect(motivos.some((m) => m.startsWith("dump.archive.gz:"))).toBe(true);
    const tudo = r.arquivos.map((a) => readFileSync(join(r.pasta, ...a.caminho.split("/")), "utf8")).join("\n");
    for (const proibido of [SENHA_FICTICIA, "BLOB", "CHAVE", "MONGO_URI", "mongodb://", "abcdefghijklmnop", "xyz123"]) expect(tudo.includes(proibido)).toBe(false);
  });
  it("sanitização: URI, senha em JSON, chave=valor, Bearer, chave privada, segredo literal", () => {
    const s = sanitizarTexto('{"password":"p1","pwd":"p2"} mongodb+srv://u:p@h/x senha=abc Bearer qwertyuiop -----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY----- LITERAL123', ["LITERAL123"]);
    expect(s.alterado).toBe(true);
    for (const p of ["p1", "p2", "u:p@h", "abc", "qwertyuiop", "AAA", "LITERAL123"]) expect(s.texto.includes(p)).toBe(false);
    expect(sanitizarTexto('{"resultado":"PASSOU","porta":27118}').alterado).toBe(false);
  });
  it("destino DENTRO do repositório, da raiz isolada ou de uma origem ⇒ recusado (a limpeza apagaria o pacote)", () => {
    expect(conferirDestino({ destino: join(REPO, "evidencias-x"), origens: [origem], repositorio: REPO, raizIsolada: raizIso })).toContain("repositório");
    expect(conferirDestino({ destino: join(raizIso, "p"), origens: [origem], repositorio: REPO, raizIsolada: raizIso })).toContain("raiz da instância");
    expect(conferirDestino({ destino: join(origem, "p"), origens: [origem], repositorio: REPO, raizIsolada: raizIso })).toContain("origem");
    expect(conferirDestino({ destino: "relativo/x", origens: [], repositorio: REPO, raizIsolada: raizIso })).toContain("absoluto");
    expect(() => criar({ destino: join(origem, "p") })).toThrow("recusado");
    expect(readdirSync(origem).includes("p")).toBe(false);
  });
  it("o pacote SOBREVIVE à limpeza do runner (remoção da pasta de origem)", () => {
    const r = criar();
    rmSync(origem, { recursive: true, force: true });
    expect(conferirPacote(r.pasta).ok).toBe(true);
  });
  it("nunca sobrescreve: mesmo id ⇒ erro; ids diferentes ⇒ pacotes distintos", () => {
    criar({ id: "fixo_000001" });
    expect(() => criar({ id: "fixo_000001" })).toThrow();
    const a = criar();
    const b = criar();
    expect(a.id).not.toBe(b.id);
  });
  it("adulteração do pacote é detectada (arquivo alterado, removido ou acrescentado)", () => {
    const r = criar();
    writeFileSync(join(r.pasta, "resultados.json"), "[]");
    writeFileSync(join(r.pasta, "extra.txt"), "x");
    const c = conferirPacote(r.pasta);
    expect(c.ok).toBe(false);
    expect(c.problemas.join()).toContain("SHA-256 divergente: resultados.json");
    expect(c.problemas.join()).toContain("fora do manifesto: extra.txt");
  });
});
