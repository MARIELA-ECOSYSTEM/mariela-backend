import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { deserialize, EJSON, type Document } from "bson";

/**
 * Fase 60.4.3.4.21.2 — leitura ESTRUTURAL de um archive do `mongodump --archive --gzip` (Database Tools 100.x), sem
 * restaurar nada. Formato (conferido num dump real do 100.17.0):
 *   magic int32 0x8199e26d · cabeçalho BSON {concurrent_collections, version, server_version, tool_version}
 *   · prelude: 1 BSON {db, collection, metadata(JSON estendido com índices/opções), size, type} por coleção · terminador
 *   · corpo: blocos {db, collection, EOF:false, CRC} + documentos + terminador; cada coleção termina com
 *     {db, collection, EOF:true, CRC} + terminador.
 * Documentos de DADOS nunca são desserializados (só contados e checados quanto ao tamanho/byte final): nenhum dado
 * pessoal é lido por esta validação.
 */

export const MAGIC_ARCHIVE = 0x8199e26d;
const TERMINADOR = -1;
/** Limite de memória da descompactação (falha FECHADA acima disso — documentado em docs/backup-mongodb.md). */
export const LIMITE_DESCOMPACTADO_BYTES = 1024 * 1024 * 1024;

export type CodigoArchiveInvalido = "GZIP_INVALIDO" | "MAGIC_INVALIDO" | "TRUNCADO" | "ESTRUTURA_INVALIDA" | "GRANDE_DEMAIS";

export class ArchiveInvalidoErro extends Error {
  constructor(
    readonly codigo: CodigoArchiveInvalido,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ArchiveInvalidoErro";
  }
}

export interface IndiceNormalizado {
  nome: string;
  chave: string;
  unique: boolean;
  parcial: string | null;
  sparse: boolean;
  ttl: number | null;
}

/**
 * Fase 60.4.3.4.21.2.8 (A21-7-03) — especificação COMPLETA de um índice: todas as opções (collation, hidden, text/geo,
 * unique, partial, sparse, TTL, wildcardProjection…), em forma canônica. Só são ignorados campos sem efeito semântico:
 *   `v`  — versão interna do formato do índice, escolhida pelo servidor;
 *   `ns` — namespace (redundante; ausente desde o 4.4);
 *   `background` — opção de CONSTRUÇÃO, ignorada pelo servidor desde o 4.2 (não altera o índice construído).
 * A ordem das chaves de `key` é PRESERVADA (é significativa); nas demais opções as chaves são ordenadas. Números BSON são
 * comparados por valor (1, 1.0 e Int32(1) são o mesmo sentido de índice).
 */
export interface EspecificacaoIndice {
  nome: string;
  especificacao: string;
}

/** Opções de COLEÇÃO comparáveis (canônicas), SEM o trio de validação (validator/nível/ação), conferido à parte. */
export const CAMPOS_VALIDACAO = ["validator", "validationLevel", "validationAction"] as const;

export interface ColecaoDoArchive {
  db: string;
  colecao: string;
  tipo: string;
  opcoes: Record<string, unknown>;
  indices: IndiceNormalizado[];
  /** Fase 21.2.8: índices completos (para a validação do restore). */
  especificacoes: EspecificacaoIndice[];
}

export interface ArchiveLido {
  versaoServidor: string | null;
  versaoFerramenta: string | null;
  versaoFormato: string | null;
  colecoes: ColecaoDoArchive[];
  /** Documentos de dados por namespace `db.colecao`. */
  documentos: Record<string, number>;
  /** Namespaces com bloco de fim (EOF) — todos os do prelude precisam ter. */
  comFim: string[];
  bytesDescompactados: number;
}

/**
 * Forma canônica de um valor de índice, igual para o que vem do archive (EJSON → `Int32`/`Long`) e do driver
 * (números JS): números BSON viram `number`, ordem das chaves preservada (é significativa em índices compostos).
 * Não depende da identidade da classe `bson` (o driver pode usar outra cópia do pacote).
 */
function canonico(valor: unknown): unknown {
  if (valor === null || typeof valor !== "object") return valor;
  const tipo = (valor as { _bsontype?: string })._bsontype;
  if (tipo === "Int32" || tipo === "Double" || tipo === "Long" || tipo === "Decimal128") return Number(String(valor));
  if (Array.isArray(valor)) return valor.map(canonico);
  return Object.fromEntries(Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, canonico(v)]));
}

/** Normaliza um índice (da origem ou do archive) para comparação estável. */
export function normalizarIndice(indice: Document): IndiceNormalizado {
  const ttl = canonico(indice["expireAfterSeconds"]);
  return {
    nome: String(indice["name"]),
    chave: JSON.stringify(canonico(indice["key"] ?? {})),
    unique: indice["unique"] === true,
    parcial: indice["partialFilterExpression"] ? JSON.stringify(canonico(indice["partialFilterExpression"])) : null,
    sparse: indice["sparse"] === true,
    ttl: typeof ttl === "number" ? ttl : null,
  };
}

export function ordenarIndices(indices: IndiceNormalizado[]): IndiceNormalizado[] {
  return [...indices].sort((a, b) => a.nome.localeCompare(b.nome));
}

/** Canônico com chaves ORDENADAS (para opções cuja ordem não tem significado). */
function canonicoOrdenado(valor: unknown): unknown {
  const c = canonico(valor);
  const ordenar = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(ordenar);
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, ordenar((v as Record<string, unknown>)[k])]));
  };
  return ordenar(c);
}

const IGNORADOS_NO_INDICE = new Set(["v", "ns", "background"]);

/** Especificação completa e canônica de um índice (Fase 21.2.8, A21-7-03). */
export function especificacaoIndice(indice: Document): EspecificacaoIndice {
  const campos = Object.keys(indice).filter((k) => !IGNORADOS_NO_INDICE.has(k)).sort();
  const partes = campos.map((k) => {
    // `key`: a ORDEM dos campos é significativa (índice composto) — não ordenar.
    const v = k === "key" ? canonico(indice[k]) : canonicoOrdenado(indice[k]);
    return [k, v] as const;
  });
  return { nome: String(indice["name"]), especificacao: JSON.stringify(partes) };
}

export function ordenarEspecificacoes(e: EspecificacaoIndice[]): EspecificacaoIndice[] {
  return [...e].sort((a, b) => (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0));
}

/** Opções de coleção canônicas SEM o trio de validação (Fase 21.2.8, A21-7-03). */
export function opcoesComparaveis(opcoes: Record<string, unknown> | null | undefined): string {
  const o = { ...(opcoes ?? {}) };
  for (const c of CAMPOS_VALIDACAO) delete o[c];
  return JSON.stringify(canonicoOrdenado(o));
}

export function descompactar(gz: Buffer): Buffer {
  if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) throw new ArchiveInvalidoErro("GZIP_INVALIDO", "o arquivo não é gzip (cabeçalho ausente)");
  try {
    return gunzipSync(gz, { maxOutputLength: LIMITE_DESCOMPACTADO_BYTES });
  } catch (erro) {
    const codigo = (erro as { code?: string }).code;
    if (codigo === "ERR_BUFFER_TOO_LARGE") throw new ArchiveInvalidoErro("GRANDE_DEMAIS", "archive descompactado acima do limite");
    throw new ArchiveInvalidoErro("GZIP_INVALIDO", "gzip ilegível ou truncado");
  }
}

/** Lê a estrutura do archive JÁ descompactado. Lança `ArchiveInvalidoErro` em qualquer inconsistência. */
export function lerArchive(dados: Buffer): ArchiveLido {
  if (dados.length < 4 || dados.readUInt32LE(0) !== MAGIC_ARCHIVE) throw new ArchiveInvalidoErro("MAGIC_INVALIDO", "assinatura de archive do mongodump ausente");
  let pos = 4;

  const tamanhoEm = (p: number): number => {
    if (p + 4 > dados.length) throw new ArchiveInvalidoErro("TRUNCADO", "fim inesperado do archive");
    return dados.readInt32LE(p);
  };
  const ehTerminador = (): boolean => pos + 4 <= dados.length && dados.readInt32LE(pos) === TERMINADOR;
  const limitesDoDocumento = (): number => {
    const tamanho = tamanhoEm(pos);
    if (tamanho < 5 || pos + tamanho > dados.length) throw new ArchiveInvalidoErro("TRUNCADO", "documento BSON truncado");
    if (dados[pos + tamanho - 1] !== 0) throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "documento BSON sem byte final");
    return tamanho;
  };
  const lerDocumento = (): Document => {
    const tamanho = limitesDoDocumento();
    let doc: Document;
    try {
      doc = deserialize(dados.subarray(pos, pos + tamanho));
    } catch {
      throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "documento de controle ilegível");
    }
    pos += tamanho;
    return doc;
  };

  const cabecalho = lerDocumento();
  const colecoes: ColecaoDoArchive[] = [];
  while (!ehTerminador()) {
    if (pos >= dados.length) throw new ArchiveInvalidoErro("TRUNCADO", "prelude sem terminador");
    const meta = lerDocumento();
    if (typeof meta["db"] !== "string" || typeof meta["collection"] !== "string") throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "metadado de coleção sem db/collection");
    let metadados: Document = {};
    if (typeof meta["metadata"] === "string" && meta["metadata"].length > 0) {
      try {
        metadados = EJSON.parse(meta["metadata"], { relaxed: false }) as Document;
      } catch {
        throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "metadados de coleção ilegíveis");
      }
    }
    colecoes.push({
      db: meta["db"],
      colecao: meta["collection"],
      tipo: typeof meta["type"] === "string" ? meta["type"] : "collection",
      opcoes: (metadados["options"] as Record<string, unknown>) ?? {},
      indices: ordenarIndices(((metadados["indexes"] as Document[]) ?? []).map(normalizarIndice)),
      especificacoes: ordenarEspecificacoes(((metadados["indexes"] as Document[]) ?? []).map(especificacaoIndice)),
    });
  }
  pos += 4;

  const documentos: Record<string, number> = {};
  const comFim = new Set<string>();
  while (pos < dados.length) {
    const cabecalhoBloco = lerDocumento();
    if (typeof cabecalhoBloco["db"] !== "string" || typeof cabecalhoBloco["collection"] !== "string") {
      throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "bloco sem namespace");
    }
    const ns = `${cabecalhoBloco["db"]}.${cabecalhoBloco["collection"]}`;
    if (cabecalhoBloco["EOF"] === true) {
      if (!ehTerminador()) throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "fim de coleção sem terminador");
      comFim.add(ns);
      pos += 4;
      continue;
    }
    let n = 0;
    while (!ehTerminador()) {
      if (pos >= dados.length) throw new ArchiveInvalidoErro("TRUNCADO", "bloco de dados sem terminador");
      pos += limitesDoDocumento(); // dados: só o tamanho — nunca desserializados
      n += 1;
    }
    pos += 4;
    documentos[ns] = (documentos[ns] ?? 0) + n;
  }

  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    versaoServidor: str(cabecalho["server_version"]),
    versaoFerramenta: str(cabecalho["tool_version"]),
    versaoFormato: str(cabecalho["version"]),
    colecoes,
    documentos,
    comFim: [...comFim].sort(),
    bytesDescompactados: dados.length,
  };
}

export function lerArchiveGzipDoArquivo(caminho: string): ArchiveLido {
  return lerArchive(descompactar(readFileSync(caminho)));
}

/** Tamanho do VALOR de um elemento BSON a partir de `p` (início do valor); `null` = tipo não suportado como _id. */
function tamanhoDoValorBson(tipo: number, dados: Buffer, p: number): number | null {
  switch (tipo) {
    case 0x01: // double
    case 0x09: // date
    case 0x11: // timestamp
    case 0x12: // int64
      return 8;
    case 0x02: // string
    case 0x0d: // javascript
    case 0x0e: // symbol
      return 4 + dados.readInt32LE(p);
    case 0x03: // documento
    case 0x04: // array
      return dados.readInt32LE(p);
    case 0x05: // binário
      return 4 + 1 + dados.readInt32LE(p);
    case 0x07: // ObjectId
      return 12;
    case 0x08: // booleano
      return 1;
    case 0x0a: // null
      return 0;
    case 0x10: // int32
      return 4;
    case 0x13: // decimal128
      return 16;
    default:
      return null;
  }
}

/**
 * CHAVE CANÔNICA do `_id` de um documento BSON BRUTO = bytes do elemento `_id` (tipo + nome + valor) em hex. Preserva o
 * tipo (Int32 7 ≠ Int64 7 ≠ Double 7 ≠ "7"). Exige que o PRIMEIRO elemento seja `_id` (o MongoDB sempre o grava
 * primeiro; o mongodump o exporta assim). Fora disso ⇒ ArchiveInvalidoErro (falha fechada). Usada no archive E no banco.
 */
export function chaveDoIdBruto(doc: Uint8Array): string {
  const dados = Buffer.from(doc.buffer, doc.byteOffset, doc.byteLength);
  if (dados.length < 5) throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "documento BSON curto demais");
  const t = dados.readInt32LE(0);
  if (t !== dados.length || dados[t - 1] !== 0) throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "documento BSON com tamanho inconsistente");
  const fimDoc = t - 1;
  const tipo = dados[4]!;
  const fimNome = dados.indexOf(0, 5);
  if (fimNome < 0 || fimNome >= fimDoc || dados.toString("latin1", 5, fimNome) !== "_id") {
    throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "documento cujo primeiro campo não é _id");
  }
  const tamanhoValor = tamanhoDoValorBson(tipo, dados, fimNome + 1);
  if (tamanhoValor === null || fimNome + 1 + tamanhoValor > fimDoc) throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", `_id de tipo BSON 0x${tipo.toString(16)} não suportado`);
  return dados.toString("hex", 4, fimNome + 1 + tamanhoValor);
}

/** SHA-256 (hex) dos BYTES do documento BSON — representação canônica de CONTEÚDO (tipos, ordem e valores exatos). */
export function hashDoDocumentoBruto(doc: Uint8Array): string {
  return createHash("sha256").update(doc).digest("hex");
}

/**
 * Percorre os documentos de DADOS do archive (nunca os de controle), entregando o namespace e os BYTES BSON brutos de
 * cada documento, exatamente como o mongodump os gravou (e como o mongorestore os insere).
 */
export function percorrerDocumentosDoArchive(dados: Buffer, visitar: (ns: string, doc: Buffer) => void): void {
  if (dados.length < 4 || dados.readUInt32LE(0) !== MAGIC_ARCHIVE) throw new ArchiveInvalidoErro("MAGIC_INVALIDO", "assinatura de archive do mongodump ausente");
  let pos = 4;
  const tamanhoDoc = (): number => {
    if (pos + 4 > dados.length) throw new ArchiveInvalidoErro("TRUNCADO", "fim inesperado do archive");
    const t = dados.readInt32LE(pos);
    if (t < 5 || pos + t > dados.length) throw new ArchiveInvalidoErro("TRUNCADO", "documento BSON truncado");
    return t;
  };
  const ehTerminador = () => pos + 4 <= dados.length && dados.readInt32LE(pos) === TERMINADOR;
  const controle = (): Document => {
    const t = tamanhoDoc();
    const doc = deserialize(dados.subarray(pos, pos + t));
    pos += t;
    return doc;
  };
  controle(); // cabeçalho
  while (!ehTerminador()) {
    if (pos >= dados.length) throw new ArchiveInvalidoErro("TRUNCADO", "prelude sem terminador");
    controle();
  }
  pos += 4;
  while (pos < dados.length) {
    const cab = controle();
    const ns = `${cab["db"]}.${cab["collection"]}`;
    if (cab["EOF"] === true) {
      pos += 4;
      continue;
    }
    visitar(ns, dados.subarray(pos, pos)); // garante o namespace mesmo sem documentos
    while (!ehTerminador()) {
      if (pos >= dados.length) throw new ArchiveInvalidoErro("TRUNCADO", "bloco de dados sem terminador");
      const t = tamanhoDoc();
      visitar(ns, dados.subarray(pos, pos + t));
      pos += t;
    }
    pos += 4;
  }
}

/**
 * Fase 60.4.3.4.21.2.6 (A-01/A-04) — CONTEÚDO de cada namespace do archive: chave canônica do `_id` → SHA-256 dos bytes
 * do documento. `_id` repetido no mesmo namespace ⇒ ArchiveInvalidoErro.
 */
export function conteudoDoArchive(dados: Buffer): Map<string, Map<string, string>> {
  const r = new Map<string, Map<string, string>>();
  percorrerDocumentosDoArchive(dados, (ns, doc) => {
    const m = r.get(ns) ?? new Map<string, string>();
    r.set(ns, m);
    if (doc.length === 0) return;
    const chave = chaveDoIdBruto(doc);
    if (m.has(chave)) throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", `_id repetido em ${ns}`);
    m.set(chave, hashDoDocumentoBruto(doc));
  });
  return r;
}

export function conteudoDoArchiveGzipDoArquivo(caminho: string): Map<string, Map<string, string>> {
  return conteudoDoArchive(descompactar(readFileSync(caminho)));
}

/** Conjunto de `_id` (chaves canônicas) de cada namespace — derivado do conteúdo. */
export function idsDoArchive(dados: Buffer): Map<string, Set<string>> {
  const ids = new Map<string, Set<string>>();
  percorrerDocumentosDoArchive(dados, (ns, doc) => {
    const s = ids.get(ns) ?? new Set<string>();
    ids.set(ns, s);
    if (doc.length) s.add(chaveDoIdBruto(doc));
  });
  return ids;
}

export function idsDoArchiveGzipDoArquivo(caminho: string): Map<string, Set<string>> {
  return idsDoArchive(descompactar(readFileSync(caminho)));
}

export interface Verificacao {
  id: string;
  ok: boolean;
  detalhe: string;
}

/**
 * Confere o archive contra a política: um único banco, EXATAMENTE as coleções esperadas (nenhuma a mais, nenhuma a
 * menos — inclusive as excluídas), todas com bloco de fim, versão do servidor registrada.
 */
export function verificarArchiveContraPolitica(archive: ArchiveLido, banco: string, esperadas: readonly string[]): Verificacao[] {
  const bancos = [...new Set(archive.colecoes.map((c) => c.db))];
  const nomes = archive.colecoes.map((c) => c.colecao).sort();
  const esperadasOrd = [...esperadas].sort();
  const faltando = esperadasOrd.filter((n) => !nomes.includes(n));
  const sobrando = nomes.filter((n) => !esperadasOrd.includes(n));
  const duplicadas = nomes.filter((n, i) => nomes.indexOf(n) !== i);
  const semFim = archive.colecoes.map((c) => `${c.db}.${c.colecao}`).filter((ns) => !archive.comFim.includes(ns));
  const nsNoCorpo = Object.keys(archive.documentos).filter((ns) => !archive.colecoes.some((c) => `${c.db}.${c.colecao}` === ns));
  return [
    { id: "archive.banco_unico", ok: bancos.length === 1 && bancos[0] === banco, detalhe: `bancos no archive: ${JSON.stringify(bancos)}` },
    {
      id: "archive.colecoes_exatas",
      ok: faltando.length === 0 && sobrando.length === 0 && duplicadas.length === 0,
      detalhe: `${nomes.length} coleções; faltando=${JSON.stringify(faltando)} sobrando=${JSON.stringify(sobrando)} duplicadas=${JSON.stringify(duplicadas)}`,
    },
    { id: "archive.todas_com_fim", ok: semFim.length === 0, detalhe: `sem bloco de fim: ${JSON.stringify(semFim)}` },
    { id: "archive.corpo_sem_namespace_estranho", ok: nsNoCorpo.length === 0, detalhe: `namespaces só no corpo: ${JSON.stringify(nsNoCorpo)}` },
    { id: "archive.versao_servidor", ok: !!archive.versaoServidor, detalhe: `server_version=${archive.versaoServidor ?? "ausente"}` },
  ];
}

export async function sha256DoArquivo(caminho: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolver, rejeitar) => {
    createReadStream(caminho)
      .on("data", (pedaco) => hash.update(pedaco))
      .on("end", () => resolver())
      .on("error", rejeitar);
  });
  return hash.digest("hex").toUpperCase();
}

/** `8.0.37` → `{ maior: 8, menor: 0, correcao: 37 }`; `null` se o texto não for uma versão. */
export function partesDaVersao(versao: string | null): { maior: number; menor: number; correcao: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(versao ?? "");
  return m ? { maior: Number(m[1]), menor: Number(m[2]), correcao: Number(m[3]) } : null;
}
