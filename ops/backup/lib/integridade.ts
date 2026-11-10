import { createHash } from "node:crypto";
import type { Db, Document } from "mongodb";
import { chaveDoIdBruto, hashDoDocumentoBruto, normalizarIndice, type IndiceNormalizado, type Verificacao } from "./archive.js";
import { BANCO_ORIGEM } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2.6 (A-01, A-04) — INTEGRIDADE DE CONTEÚDO archive × destino.
 *
 * Representação canônica: os BYTES BSON do documento, como o servidor os devolve (`raw: true`). O mongorestore insere
 * os documentos do archive sem reescrevê-los, e o servidor preserva ordem de campos, tipos e valores — comprovado com
 * ObjectId, String, Int32, Int64, Double (inclusive −0), Decimal128, Date, Binary, UUID, Timestamp, documentos e
 * arrays aninhados, null e campos ausentes (sonda e testes da fase). Nada passa por JSON: nenhum tipo é perdido.
 *
 * Detecta: campo alterado/adicionado/removido, mudança de tipo, delete+insert que preserva contagem, documento alheio
 * com `_id` esperado (conteúdo diferente), documento adicional e documento faltante. Qualquer documento que não possa
 * ser lido de forma canônica (primeiro campo não é `_id`, tipo de `_id` não suportado) ⇒ falha fechada.
 */

/** chave canônica do `_id` → SHA-256 dos bytes do documento. */
export type ConteudoColecao = Map<string, string>;

export interface ComparacaoColecao {
  colecao: string;
  ok: boolean;
  esperados: number;
  encontrados: number;
  /** `_id` do archive ausentes no destino. */
  faltando: number;
  /** `_id` que não existem no archive (documento adicional/alheio). */
  alheios: number;
  /** `_id` do archive com CONTEÚDO diferente (update, substituição, mudança de tipo, campo a mais/a menos). */
  divergentes: number;
  /** `_id` repetido no destino (não deveria ser possível) ou documento ilegível. */
  invalidos: number;
  /** Hash reproduzível do conteúdo encontrado (pares chave:hash ordenados). */
  hashEncontrado: string;
  /** Hash reproduzível do conteúdo esperado (archive). */
  hashEsperado: string;
}

/** Hash reproduzível de uma coleção: SHA-256 de "chave:hash\n" em ordem lexicográfica das chaves. */
export function hashDaColecao(conteudo: ConteudoColecao): string {
  const h = createHash("sha256");
  for (const chave of [...conteudo.keys()].sort()) h.update(`${chave}:${conteudo.get(chave)}\n`);
  return h.digest("hex");
}

/**
 * Comparação PURA. `modo: "igual"` (validação final: conjunto e conteúdo idênticos) ou `"subconjunto"` (limpeza de um
 * restore parcial: tudo o que existe no destino tem de existir, IDÊNTICO, no archive — faltar é aceito).
 */
export function compararColecao(colecao: string, esperado: ConteudoColecao, documentos: Iterable<Uint8Array>, modo: "igual" | "subconjunto"): ComparacaoColecao {
  const encontrado: ConteudoColecao = new Map();
  let alheios = 0;
  let divergentes = 0;
  let invalidos = 0;
  for (const doc of documentos) {
    let chave: string;
    try {
      chave = chaveDoIdBruto(doc);
    } catch {
      invalidos += 1;
      continue;
    }
    if (encontrado.has(chave)) {
      invalidos += 1;
      continue;
    }
    const hash = hashDoDocumentoBruto(doc);
    encontrado.set(chave, hash);
    const esp = esperado.get(chave);
    if (esp === undefined) alheios += 1;
    else if (esp !== hash) divergentes += 1;
  }
  let faltando = 0;
  for (const chave of esperado.keys()) if (!encontrado.has(chave)) faltando += 1;
  const ok = alheios === 0 && divergentes === 0 && invalidos === 0 && (modo === "subconjunto" || faltando === 0);
  return {
    colecao,
    ok,
    esperados: esperado.size,
    encontrados: encontrado.size,
    faltando,
    alheios,
    divergentes,
    invalidos,
    hashEncontrado: hashDaColecao(encontrado),
    hashEsperado: hashDaColecao(esperado),
  };
}

/** Lê TODOS os documentos de uma coleção como BSON bruto (sem desserializar). */
export async function documentosBrutos(db: Db, colecao: string): Promise<Uint8Array[]> {
  const docs: Uint8Array[] = [];
  // `raw: true`: o driver entrega os bytes exatamente como o servidor os enviou.
  for await (const d of db.collection(colecao).find({}, { raw: true } as Document)) docs.push(d as unknown as Uint8Array);
  return docs;
}

/** Conteúdo esperado de cada coleção (sem o prefixo do banco), a partir do mapa por namespace do archive. */
export function conteudoPorColecao(porNamespace: Map<string, Map<string, string>>): Map<string, ConteudoColecao> {
  const r = new Map<string, ConteudoColecao>();
  for (const [ns, m] of porNamespace) if (ns.startsWith(`${BANCO_ORIGEM}.`)) r.set(ns.slice(BANCO_ORIGEM.length + 1), m);
  return r;
}

export async function compararConteudoDoDestino(db: Db, esperado: Map<string, ConteudoColecao>, colecoes: readonly string[], modo: "igual" | "subconjunto"): Promise<ComparacaoColecao[]> {
  const r: ComparacaoColecao[] = [];
  for (const c of colecoes) r.push(compararColecao(c, esperado.get(c) ?? new Map(), await documentosBrutos(db, c), modo));
  return r;
}

/** Índices do destino × manifesto: `igual` (validação final) ou `subconjunto` (limpeza). */
export async function compararIndices(db: Db, colecao: string, esperados: IndiceNormalizado[], modo: "igual" | "subconjunto"): Promise<{ ok: boolean; alheios: string[]; faltando: string[] }> {
  const atuais = (await db.collection(colecao).indexes()).map((i) => normalizarIndice(i as Document));
  const esp = new Set(esperados.map((i) => JSON.stringify(i)));
  const atu = new Set(atuais.map((i) => JSON.stringify(i)));
  const alheios = atuais.filter((i) => !esp.has(JSON.stringify(i))).map((i) => i.nome);
  const faltando = esperados.filter((i) => !atu.has(JSON.stringify(i))).map((i) => i.nome);
  return { ok: alheios.length === 0 && (modo === "subconjunto" || faltando.length === 0), alheios, faltando };
}

export function resumoComparacao(c: ComparacaoColecao[]): Verificacao {
  const ruins = c.filter((x) => !x.ok);
  return {
    id: "integridade.conteudo",
    ok: ruins.length === 0,
    detalhe: ruins.length
      ? ruins.map((x) => `${x.colecao}(faltando=${x.faltando}, alheios=${x.alheios}, divergentes=${x.divergentes}, invalidos=${x.invalidos})`).join("; ")
      : `${c.length} coleções com conteúdo idêntico ao archive (${c.reduce((s, x) => s + x.encontrados, 0)} documentos)`,
  };
}
