import { describe, expect, it } from "bun:test";
import { Binary, Decimal128, Double, Int32, Long, ObjectId, serialize, Timestamp, UUID, type Document } from "bson";
import { ArchiveInvalidoErro, chaveDoIdBruto, conteudoDoArchive } from "./archive.js";
import { compararColecao, conteudoPorColecao, hashDaColecao } from "./integridade.js";
import { ESTADOS_DESTINO, transicaoPermitida, TRANSICOES_DESTINO } from "./politica.js";
import { chaveDoId } from "./posse.js";
import { montarArchive } from "./teste-archive.util.js";

/**
 * Fase 60.4.3.4.21.2.6 (A-01/A-04/A-10) — comparação CANÔNICA archive × destino, sem MongoDB. Os "documentos do
 * destino" são BSON serializado, exatamente o que o servidor devolve com `raw: true`.
 */

const oid = new ObjectId("65a1b2c3d4e5f60718293a4b");
const completo = (): Document => ({
  _id: oid,
  s: "texto",
  i: new Int32(1),
  l: Long.fromNumber(2),
  d: new Double(1.0),
  dz: new Double(-0),
  dec: Decimal128.fromString("1.10"),
  dt: new Date(1700000000123),
  b: new Binary(Buffer.from([1, 2, 3]), 0),
  u: new UUID("0f8fad5b-d9cb-469f-a165-70867728950e"),
  ts: new Timestamp({ t: 5, i: 7 }),
  emb: { a: [1, { b: null }], c: "z" },
  arr: [1, 2, 3],
  n: null,
});
const simples = (): Document => ({ _id: "id-texto", v: 1 });
const ids = (): Document[] => [{ _id: new Int32(7) }, { _id: Long.fromNumber(8) }, { _id: new UUID("1b4e28ba-2fa1-11d2-883f-0016d3cca427") }, { _id: Decimal128.fromString("9.99") }, { _id: { composto: 1, parte: "a" } }, { _id: new Double(3.5) }, { _id: new Date(1) }];
const base = () => [completo(), simples(), ...ids()];
const esperado = conteudoPorColecao(conteudoDoArchive(montarArchive({ colecoes: [{ db: "marielaDB", colecao: "eventos_auth", docs: base() }] }))).get("eventos_auth")!;
const comparar = (docs: Document[], modo: "igual" | "subconjunto" = "igual") => compararColecao("eventos_auth", esperado, docs.map((d) => serialize(d)), modo);
const com = (alteracao: (d: Document) => void): Document[] => {
  const docs = base();
  alteracao(docs[0]!);
  return docs;
};

describe("integridade canônica (bytes BSON)", () => {
  it("conteúdo exato ⇒ ok, com hash reproduzível", () => {
    const r = comparar(base());
    expect(r.ok).toBe(true);
    expect(r.encontrados).toBe(9);
    expect(r.hashEncontrado).toBe(r.hashEsperado);
    expect(hashDaColecao(esperado)).toBe(r.hashEsperado);
  });

  const divergencias: [string, (d: Document) => void][] = [
    ["update de campo preservando _id", (d) => { d["s"] = "alterado"; }],
    ["campo adicional", (d) => { d["extra"] = 1; }],
    ["campo removido", (d) => { delete d["s"]; }],
    ["Int32 → Int64 (mesmo valor)", (d) => { d["i"] = Long.fromNumber(1); }],
    ["Double → Int32 (mesmo valor)", (d) => { d["d"] = new Int32(1); }],
    ["Double −0 → +0", (d) => { d["dz"] = new Double(0); }],
    ["Binary conteúdo", (d) => { d["b"] = new Binary(Buffer.from([1, 2, 4]), 0); }],
    ["Binary subtipo", (d) => { d["b"] = new Binary(Buffer.from([1, 2, 3]), 128); }],
    ["Decimal128 1.10 → 1.1 (mesmo valor numérico)", (d) => { d["dec"] = Decimal128.fromString("1.1"); }],
    ["Date (+1 ms)", (d) => { d["dt"] = new Date(1700000000124); }],
    ["Timestamp", (d) => { d["ts"] = new Timestamp({ t: 5, i: 8 }); }],
    ["UUID", (d) => { d["u"] = new UUID("2f8fad5b-d9cb-469f-a165-70867728950e"); }],
    ["documento embutido", (d) => { (d["emb"] as Document)["c"] = "y"; }],
    ["array (ordem)", (d) => { d["arr"] = [3, 2, 1]; }],
    ["null → campo ausente", (d) => { delete d["n"]; }],
    ["ordem dos campos", (d) => { const s = d["s"]; delete d["s"]; d["s"] = s; }],
  ];
  for (const [nome, alt] of divergencias) {
    it(`detecta: ${nome}`, () => {
      const r = comparar(com(alt));
      expect(r.ok).toBe(false);
      expect(r.divergentes).toBe(1);
    });
  }

  it("detecta: delete + insert que preserva a contagem (documento alheio)", () => {
    const docs = base().filter((d) => d["_id"] !== "id-texto");
    docs.push({ _id: "ALHEIO", alheio: true });
    const r = comparar(docs);
    expect(r.ok).toBe(false);
    expect(r.encontrados).toBe(9);
    expect(r.alheios).toBe(1);
    expect(r.faltando).toBe(1);
  });

  it("detecta: documento alheio com _id esperado (substituição)", () => {
    const docs = base().map((d) => (d["_id"] === "id-texto" ? { _id: "id-texto", alheio: true } : d));
    expect(comparar(docs).divergentes).toBe(1);
  });

  it("detecta: documento adicional", () => {
    const r = comparar([...base(), { _id: new ObjectId(), alheio: true }]);
    expect(r.ok).toBe(false);
    expect(r.alheios).toBe(1);
  });

  it("detecta: _id de OUTRO tipo com o mesmo valor (Int32 7 → Int64 7)", () => {
    const docs = base().map((d) => (d["_id"] instanceof Int32 ? { _id: Long.fromNumber(7) } : d));
    const r = comparar(docs);
    expect(r.alheios).toBe(1);
    expect(r.faltando).toBe(1);
  });

  it("documento faltando: reprova em 'igual'; aceito em 'subconjunto' (limpeza de restore parcial)", () => {
    const docs = base().slice(1);
    expect(comparar(docs, "igual").ok).toBe(false);
    expect(comparar(docs, "subconjunto").ok).toBe(true);
  });

  it("subconjunto NÃO aceita conteúdo divergente nem documento alheio", () => {
    expect(comparar(com((d) => { d["s"] = "x"; }), "subconjunto").ok).toBe(false);
    expect(comparar([{ _id: "ALHEIO" }], "subconjunto").ok).toBe(false);
  });

  it("documento cujo primeiro campo não é _id ⇒ inválido (falha fechada)", () => {
    const r = comparar([...base().slice(1), { s: "x", _id: oid }]);
    expect(r.ok).toBe(false);
    expect(r.invalidos).toBe(1);
    expect(() => chaveDoIdBruto(serialize({ a: 1, _id: 1 }))).toThrow(ArchiveInvalidoErro);
  });

  it("chave do archive = chave do driver para os mesmos _id", () => {
    for (const d of base()) expect(chaveDoIdBruto(serialize(d))).toBe(chaveDoId(d["_id"]));
  });

  it("archive com _id repetido no mesmo namespace ⇒ recusado", () => {
    expect(() => conteudoDoArchive(montarArchive({ colecoes: [{ db: "marielaDB", colecao: "x", docs: [{ _id: 1 }, { _id: 1 }] }] }))).toThrow(ArchiveInvalidoErro);
  });
});

describe("máquina de estados do destino", () => {
  it("todo estado tem transições declaradas e só para estados conhecidos", () => {
    for (const e of ESTADOS_DESTINO) for (const p of TRANSICOES_DESTINO[e]) expect(ESTADOS_DESTINO).toContain(p);
  });
  it("caminho feliz e decisões do operador", () => {
    expect(transicaoPermitida("PREPARANDO", "RESTAURANDO")).toBe(true);
    expect(transicaoPermitida("RESTAURANDO", "VALIDANDO")).toBe(true);
    expect(transicaoPermitida("VALIDANDO", "VERIFICADO")).toBe(true);
    expect(transicaoPermitida("VERIFICADO", "LIBERACAO_AUTORIZADA")).toBe(true);
    // Fase 21.2.8 (A21-7-04): remoção sempre via REMOVENDO.
    expect(transicaoPermitida("VERIFICADO", "REMOVENDO")).toBe(true);
    expect(transicaoPermitida("REMOVENDO", "CANCELADO_COM_LIMPEZA_COMPROVADA")).toBe(true);
    expect(transicaoPermitida("VERIFICADO", "CANCELADO_COM_LIMPEZA_COMPROVADA")).toBe(false);
  });
  it("atalhos proibidos", () => {
    expect(transicaoPermitida("RESTAURANDO", "VERIFICADO")).toBe(false); // sem validar
    expect(transicaoPermitida("PREPARANDO", "VERIFICADO")).toBe(false);
    expect(transicaoPermitida("VALIDANDO", "LIBERACAO_AUTORIZADA")).toBe(false); // liberação só depois de VERIFICADO
    expect(transicaoPermitida("FALHOU_DESTINO_PARCIAL", "VERIFICADO")).toBe(false);
    expect(transicaoPermitida("INTERVENCAO_NECESSARIA", "VERIFICADO")).toBe(false);
    expect(transicaoPermitida("LIBERACAO_AUTORIZADA", "VERIFICADO")).toBe(false);
    expect(TRANSICOES_DESTINO.CANCELADO_COM_LIMPEZA_COMPROVADA).toEqual([]);
  });
});
