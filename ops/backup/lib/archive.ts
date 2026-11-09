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

export interface ColecaoDoArchive {
  db: string;
  colecao: string;
  tipo: string;
  opcoes: Record<string, unknown>;
  indices: IndiceNormalizado[];
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
 * Fase 60.4.3.4.21.2.4 (R21-2.3-01) — conjunto de `_id` de cada namespace do archive, como CHAVE CANÔNICA = bytes BSON
 * do elemento `_id` (tipo + nome + valor) em hex. Lê SÓ o primeiro elemento de cada documento (o `_id`, que o MongoDB
 * sempre grava primeiro); nenhum outro campo é lido. Documento cujo primeiro campo não é `_id` ⇒ ArchiveInvalidoErro
 * (falha fechada: sem a lista exata de `_id`, nenhuma limpeza é autorizada).
 */
export function idsDoArchive(dados: Buffer): Map<string, Set<string>> {
  if (dados.length < 4 || dados.readUInt32LE(0) !== MAGIC_ARCHIVE) throw new ArchiveInvalidoErro("MAGIC_INVALIDO", "assinatura de archive do mongodump ausente");
  let pos = 4;
  const ids = new Map<string, Set<string>>();
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
    const conjunto = ids.get(ns) ?? new Set<string>();
    ids.set(ns, conjunto);
    while (!ehTerminador()) {
      if (pos >= dados.length) throw new ArchiveInvalidoErro("TRUNCADO", "bloco de dados sem terminador");
      const t = tamanhoDoc();
      const fimDoc = pos + t - 1;
      const tipo = dados[pos + 4]!;
      const fimNome = dados.indexOf(0, pos + 5);
      if (fimNome < 0 || fimNome >= fimDoc || dados.toString("latin1", pos + 5, fimNome) !== "_id") {
        throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", "documento cujo primeiro campo não é _id");
      }
      const tamanhoValor = tamanhoDoValorBson(tipo, dados, fimNome + 1);
      if (tamanhoValor === null || fimNome + 1 + tamanhoValor > fimDoc) throw new ArchiveInvalidoErro("ESTRUTURA_INVALIDA", `_id de tipo BSON 0x${tipo.toString(16)} não suportado`);
      conjunto.add(dados.toString("hex", pos + 4, fimNome + 1 + tamanhoValor));
      pos += t;
    }
    pos += 4;
  }
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
