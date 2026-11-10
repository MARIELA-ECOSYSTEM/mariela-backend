import { createHash } from "node:crypto";
import type { Db, Document } from "mongodb";
import { chaveDoIdBruto, especificacaoIndice, hashDoDocumentoBruto, opcoesComparaveis, type EspecificacaoIndice, type Verificacao } from "./archive.js";
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
/**
 * Comparador INCREMENTAL (Fase 21.2.8, A21-7-08): cada documento é processado e descartado; só ficam na memória as
 * chaves e os hashes (não os documentos).
 */
export class ComparadorColecao {
  private readonly encontrado: ConteudoColecao = new Map();
  private alheios = 0;
  private divergentes = 0;
  private invalidos = 0;
  constructor(
    private readonly colecao: string,
    private readonly esperado: ConteudoColecao,
    private readonly modo: "igual" | "subconjunto",
  ) {}

  adicionar(doc: Uint8Array): void {
    let chave: string;
    try {
      chave = chaveDoIdBruto(doc);
    } catch {
      this.invalidos += 1;
      return;
    }
    if (this.encontrado.has(chave)) {
      this.invalidos += 1;
      return;
    }
    const hash = hashDoDocumentoBruto(doc);
    this.encontrado.set(chave, hash);
    const esp = this.esperado.get(chave);
    if (esp === undefined) this.alheios += 1;
    else if (esp !== hash) this.divergentes += 1;
  }

  finalizar(): ComparacaoColecao {
    let faltando = 0;
    for (const chave of this.esperado.keys()) if (!this.encontrado.has(chave)) faltando += 1;
    const ok = this.alheios === 0 && this.divergentes === 0 && this.invalidos === 0 && (this.modo === "subconjunto" || faltando === 0);
    return {
      colecao: this.colecao,
      ok,
      esperados: this.esperado.size,
      encontrados: this.encontrado.size,
      faltando,
      alheios: this.alheios,
      divergentes: this.divergentes,
      invalidos: this.invalidos,
      hashEncontrado: hashDaColecao(this.encontrado),
      hashEsperado: hashDaColecao(this.esperado),
    };
  }
}

export function compararColecao(colecao: string, esperado: ConteudoColecao, documentos: Iterable<Uint8Array>, modo: "igual" | "subconjunto"): ComparacaoColecao {
  const c = new ComparadorColecao(colecao, esperado, modo);
  for (const doc of documentos) c.adicionar(doc);
  return c.finalizar();
}

/** Compara a coleção do destino LENDO EM FLUXO (`raw: true`: os bytes exatamente como o servidor os enviou). */
export async function compararColecaoDoDestino(db: Db, colecao: string, esperado: ConteudoColecao, modo: "igual" | "subconjunto"): Promise<ComparacaoColecao> {
  const c = new ComparadorColecao(colecao, esperado, modo);
  for await (const d of db.collection(colecao).find({}, { raw: true } as Document)) c.adicionar(d as unknown as Uint8Array);
  return c.finalizar();
}

/** Conteúdo esperado de cada coleção (sem o prefixo do banco), a partir do mapa por namespace do archive. */
export function conteudoPorColecao(porNamespace: Map<string, Map<string, string>>): Map<string, ConteudoColecao> {
  const r = new Map<string, ConteudoColecao>();
  for (const [ns, m] of porNamespace) if (ns.startsWith(`${BANCO_ORIGEM}.`)) r.set(ns.slice(BANCO_ORIGEM.length + 1), m);
  return r;
}

export async function compararConteudoDoDestino(db: Db, esperado: Map<string, ConteudoColecao>, colecoes: readonly string[], modo: "igual" | "subconjunto"): Promise<ComparacaoColecao[]> {
  const r: ComparacaoColecao[] = [];
  for (const c of colecoes) r.push(await compararColecaoDoDestino(db, c, esperado.get(c) ?? new Map(), modo));
  return r;
}

/**
 * Comparação PURA de índices pela especificação COMPLETA (Fase 21.2.8, A21-7-03). Um índice com o mesmo nome e outra
 * opção (collation, hidden, weights, 2dsphere, TTL…) é ao mesmo tempo "alheio" (o atual) e "faltando" (o esperado).
 */
export function compararEspecificacoes(atuais: EspecificacaoIndice[], esperados: EspecificacaoIndice[], modo: "igual" | "subconjunto"): { ok: boolean; alheios: string[]; faltando: string[] } {
  const esp = new Set(esperados.map((i) => `${i.nome}\u0000${i.especificacao}`));
  const atu = new Set(atuais.map((i) => `${i.nome}\u0000${i.especificacao}`));
  const alheios = atuais.filter((i) => !esp.has(`${i.nome}\u0000${i.especificacao}`)).map((i) => i.nome);
  const faltando = esperados.filter((i) => !atu.has(`${i.nome}\u0000${i.especificacao}`)).map((i) => i.nome);
  return { ok: alheios.length === 0 && (modo === "subconjunto" || faltando.length === 0), alheios, faltando };
}

/** Índices do destino × archive (especificação completa): `igual` (validação final) ou `subconjunto` (limpeza). */
export async function compararIndices(db: Db, colecao: string, esperados: EspecificacaoIndice[], modo: "igual" | "subconjunto"): Promise<{ ok: boolean; alheios: string[]; faltando: string[] }> {
  const atuais = (await db.collection(colecao).indexes()).map((i) => especificacaoIndice(i as Document));
  return compararEspecificacoes(atuais, esperados, modo);
}

/** Opções da coleção (sem o trio de validação) iguais às do archive? (A21-7-03) */
export function compararOpcoesColecao(atuais: Record<string, unknown> | null | undefined, doArchive: Record<string, unknown> | null | undefined): { ok: boolean; atual: string; esperado: string } {
  const atual = opcoesComparaveis(atuais);
  const esperado = opcoesComparaveis(doArchive);
  return { ok: atual === esperado, atual, esperado };
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
