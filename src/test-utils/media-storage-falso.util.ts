import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Types, type Connection } from "mongoose";
import { ApiException } from "../common/exceptions/api.exception.js";
import type { AssinarUploadParams, InspecaoObjeto, LeituraObjeto, LerObjetoOpcoes, MediaStorage } from "../modules/media/media.types.js";

/**
 * Fase 60.1 — storage de mídia FALSO e determinístico para os testes (nenhum teste fala com o R2 real). Simula o
 * bucket em memória: `enviar` faz o papel do `PUT` do cliente; `falhas` liga a indisponibilidade de cada operação
 * (sempre `STORAGE_UNAVAILABLE`, como o provider R2). `exclusoes` registra qualquer exclusão física — nesta fase
 * nenhuma deve acontecer.
 */
export class MediaStorageFalso implements MediaStorage {
  readonly objetos = new Map<string, { bytes: Uint8Array; contentType: string | null; tamanho: number | null; etag: string }>();
  readonly assinaturas: AssinarUploadParams[] = [];
  readonly exclusoes: string[] = [];
  readonly falhas = { assinar: false, inspecionar: false, ler: false, excluir: false };
  /** Fase 60.4.3.4.1 — cada `enviar` gera um ETag novo (simula uma nova versão do objeto). */
  private versao = 0;

  async assinarUpload(params: AssinarUploadParams): Promise<string> {
    if (this.falhas.assinar) throw ApiException.storageUnavailable();
    this.assinaturas.push(params);
    return `https://storage-falso.teste/${params.key}?X-Amz-Signature=falsa`;
  }

  async inspecionarObjeto(key: string): Promise<InspecaoObjeto> {
    if (this.falhas.inspecionar) throw ApiException.storageUnavailable();
    const objeto = this.objetos.get(key);
    return objeto ? { existe: true, tamanho: objeto.tamanho, contentType: objeto.contentType, etag: objeto.etag } : { existe: false };
  }

  /** Fase 60.4.3.4.1 — como o R2: `If-Match` diferente → `alterado`; acima de `tamanhoMaximo` → `alterado`. */
  async lerObjeto(key: string, opcoes: LerObjetoOpcoes): Promise<LeituraObjeto> {
    if (this.falhas.ler) throw ApiException.storageUnavailable();
    const objeto = this.objetos.get(key);
    if (!objeto) return { estado: "ausente" };
    if (opcoes.ifMatch !== undefined && opcoes.ifMatch !== objeto.etag) return { estado: "alterado" };
    if (objeto.bytes.length > opcoes.tamanhoMaximo) return { estado: "alterado" };
    return { estado: "lido", bytes: objeto.bytes.slice() };
  }

  async lerPrimeirosBytes(key: string, quantidade: number): Promise<Uint8Array | null> {
    if (this.falhas.ler) throw ApiException.storageUnavailable();
    const objeto = this.objetos.get(key);
    return objeto ? objeto.bytes.slice(0, quantidade) : null;
  }

  async excluirObjeto(key: string): Promise<void> {
    if (this.falhas.excluir) throw ApiException.storageUnavailable();
    this.exclusoes.push(key);
    this.objetos.delete(key);
  }

  /** Simula o `PUT` do cliente. `tamanho`/`contentType` permitem divergir do conteúdo (cenários de fraude). */
  enviar(key: string, bytes: Uint8Array, contentType: string | null, tamanho: number | null = bytes.length): void {
    this.versao += 1;
    this.objetos.set(key, { bytes, contentType, tamanho, etag: `"etag-falso-${this.versao}"` });
  }

  /** Chave da última URL assinada (a que o cliente usaria no `PUT`). */
  ultimaChave(): string {
    const ultima = this.assinaturas[this.assinaturas.length - 1];
    if (!ultima) throw new Error("Nenhuma URL foi assinada.");
    return ultima.key;
  }

  reiniciar(): void {
    this.objetos.clear();
    this.assinaturas.length = 0;
    this.exclusoes.length = 0;
    this.falhas.assinar = this.falhas.inspecionar = this.falhas.ler = this.falhas.excluir = false;
  }
}

const ASCII = (texto: string): number[] => [...texto].map((caractere) => caractere.charCodeAt(0));

/**
 * Fase 60.4.3.4.1 — arquivos REAIS mínimos (substituem os antigos "cabeçalho + zeros", que a validação estrutural
 * recusa). Gerados a partir de imagens sintéticas e do vídeo sintético da bateria R2T-20261106-221836:
 * JPEG 8×8, PNG 8×8, GIF 1×1, WebP 8×8 (VP8), MP4 H.264 progressivo (1 amostra) e fragmentado (MediaRecorder, 22 amostras).
 */
export const FIXTURES_MIDIA = {
  jpeg: "jpeg-8x8.jpg",
  png: "png-8x8.png",
  gif: "gif-1x1.gif",
  webp: "webp-8x8.webp",
  mp4Progressivo: "mp4-h264-progressivo.mp4",
  mp4Fragmentado: "mp4-h264-fragmentado.mp4",
  /** O arquivo do teste N8 da Fase 60.4.3.3.2: assinatura JPEG válida, conteúdo não decodificável (324 bytes). */
  n8: "n8-jpeg-corrompido.jpg",
} as const;

export function fixtureDeMidia(nome: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/midia/${nome}`, import.meta.url)));
}

const BASE_POR_FORMATO: Record<string, string> = {
  "image/jpeg": FIXTURES_MIDIA.jpeg,
  "image/png": FIXTURES_MIDIA.png,
  "image/gif": FIXTURES_MIDIA.gif,
  "image/webp": FIXTURES_MIDIA.webp,
  "video/mp4": FIXTURES_MIDIA.mp4Progressivo,
};

/** HTML disfarçado (conteúdo que NÃO é mídia) — cabeçalho seguido de zeros. */
const CABECALHO_HTML = ASCII("<!doctype html><script>");

const be32 = (valor: number): Uint8Array => {
  const saida = new Uint8Array(4);
  new DataView(saida.buffer).setUint32(0, valor);
  return saida;
};
const le32 = (valor: number): Uint8Array => {
  const saida = new Uint8Array(4);
  new DataView(saida.buffer).setUint32(0, valor, true);
  return saida;
};
const juntar = (...partes: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(partes));
const TABELA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = TABELA_CRC[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Chunk PNG completo (tamanho, tipo, dados, CRC). */
export function chunkPng(tipo: string, dados: Uint8Array): Uint8Array {
  const tipoEDados = juntar(new Uint8Array(ASCII(tipo)), dados);
  return juntar(be32(dados.length), tipoEDados, be32(crc32(tipoEDados)));
}

/** JPEG: segmentos COM (FF FE + tamanho) logo depois do SOI — estrutura válida que só ocupa espaço. */
function preencherJpeg(base: Uint8Array, faltam: number): Uint8Array {
  const segmentos: Uint8Array[] = [];
  let restante = faltam;
  while (restante > 0) {
    let dados = Math.min(65533, restante - 4);
    if (restante - (dados + 4) > 0 && restante - (dados + 4) < 4) dados -= 4;
    if (dados < 0) throw new Error(`JPEG: impossível acrescentar exatamente ${faltam} bytes.`);
    segmentos.push(juntar(new Uint8Array([0xff, 0xfe]), be32(dados + 2).subarray(2), new Uint8Array(dados).fill(0x52)));
    restante -= dados + 4;
  }
  return juntar(base.subarray(0, 2), ...segmentos, base.subarray(2));
}

/** PNG: chunk auxiliar privado (`prVt`) logo depois do IHDR — com CRC, ignorado pelos leitores. */
function preencherPng(base: Uint8Array, faltam: number): Uint8Array {
  if (faltam < 12) throw new Error(`PNG: impossível acrescentar ${faltam} bytes (mínimo 12).`);
  return juntar(base.subarray(0, 33), chunkPng("prVt", new Uint8Array(faltam - 12).fill(0x52)), base.subarray(33));
}

/** GIF: extensões de comentário (21 FE + sub-blocos + 00) antes do primeiro quadro. */
function preencherGif(base: Uint8Array, faltam: number): Uint8Array {
  const flags = base[10]!;
  const fimCabecalho = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  const comentario = (total: number) => (total === 3 ? new Uint8Array([0x21, 0xfe, 0x00]) : juntar(new Uint8Array([0x21, 0xfe, total - 4]), new Uint8Array(total - 4).fill(0x52), new Uint8Array([0x00])));
  const tamanhos: number[] = [];
  let restante = faltam;
  while (restante >= 259 + 5) {
    tamanhos.push(259);
    restante -= 259;
  }
  if (restante === 3 || (restante >= 5 && restante <= 259)) tamanhos.push(restante);
  else if (restante > 259) tamanhos.push(130, restante - 130);
  else if (restante !== 0) throw new Error(`GIF: impossível acrescentar exatamente ${faltam} bytes.`);
  return juntar(base.subarray(0, fimCabecalho), ...tamanhos.map(comentario), base.subarray(fimCabecalho));
}

/** WebP: converte o simples (VP8) no estendido (VP8X com a flag XMP) e ocupa o espaço num chunk `XMP `. */
function preencherWebp(base: Uint8Array, alvo: number): Uint8Array {
  const vista = new DataView(base.buffer, base.byteOffset, base.byteLength);
  const chunkImagem = base.subarray(12);
  const largura = vista.getUint16(12 + 8 + 6, true) & 0x3fff;
  const altura = vista.getUint16(12 + 8 + 8, true) & 0x3fff;
  const dadosXmp = alvo - 12 - 18 - chunkImagem.length - 8;
  if (dadosXmp < 0 || dadosXmp % 2 !== 0) throw new Error(`WebP: impossível chegar a exatamente ${alvo} bytes (tamanho par ≥ ${12 + 18 + chunkImagem.length + 8}).`);
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x04;
  vp8x.set(le32(largura - 1).subarray(0, 3), 4);
  vp8x.set(le32(altura - 1).subarray(0, 3), 7);
  const corpo = juntar(new Uint8Array(ASCII("WEBP")), new Uint8Array(ASCII("VP8X")), le32(10), vp8x, chunkImagem, new Uint8Array(ASCII("XMP ")), le32(dadosXmp), new Uint8Array(dadosXmp).fill(0x20));
  return juntar(new Uint8Array(ASCII("RIFF")), le32(corpo.length), corpo);
}

/** MP4: caixa `free` no fim (os offsets absolutos do `stco` não mudam). */
function preencherMp4(base: Uint8Array, faltam: number): Uint8Array {
  if (faltam < 8) throw new Error(`MP4: impossível acrescentar ${faltam} bytes (mínimo 8).`);
  return juntar(base, be32(faltam), new Uint8Array(ASCII("free")), new Uint8Array(faltam - 8));
}

/**
 * Arquivo REAL e estruturalmente válido de `formato`, com EXATAMENTE `tamanho` bytes (o padrão, 1024, é o `size`
 * padrão das solicitações nos testes). `text/html` continua sendo cabeçalho + zeros (conteúdo que não é mídia).
 */
export function arquivoDoFormato(formato: string, tamanho = 1024): Uint8Array {
  if (formato === "text/html") {
    const bytes = new Uint8Array(tamanho);
    bytes.set(CABECALHO_HTML.slice(0, tamanho));
    return bytes;
  }
  const nomeBase = BASE_POR_FORMATO[formato];
  if (!nomeBase) throw new Error(`Sem fixture para ${formato}.`);
  const base = fixtureDeMidia(nomeBase);
  if (tamanho === base.length) return base;
  if (tamanho < base.length) throw new Error(`O fixture de ${formato} tem ${base.length} bytes; use prefixoDoFormato para menos.`);
  const faltam = tamanho - base.length;
  switch (formato) {
    case "image/jpeg":
      return preencherJpeg(base, faltam);
    case "image/png":
      return preencherPng(base, faltam);
    case "image/gif":
      return preencherGif(base, faltam);
    case "image/webp":
      return preencherWebp(base, tamanho);
    default:
      return preencherMp4(base, faltam);
  }
}

/** Primeiros `quantidade` bytes de um arquivo real do formato (para testes que só olham a assinatura). */
export function prefixoDoFormato(formato: string, quantidade: number): Uint8Array {
  return arquivoDoFormato(formato).slice(0, quantidade);
}

export interface MidiaDiretaOpcoes {
  tipo?: "image" | "video";
  url?: string;
  origem?: "upload" | "legado";
  varianteId?: string | null;
  ordem?: number;
}

/**
 * Insere um item de galeria DIRETO no documento (sem passar pela confirmação) — só para preparar cenários de
 * leitura/compatibilidade ou de limite. Devolve o `_id` usado.
 */
interface MidiaBruta {
  _id: string;
  tipo: string;
  chave: string | null;
  url: string;
  contentType: string | null;
  tamanho: number | null;
  nomeOriginal: string | null;
  origem: string;
  varianteId: Types.ObjectId | null;
  ordem: number;
  criadoEm: Date;
  criadoPor: string | null;
}

export async function inserirMidiaDiretamente(connection: Connection, produtoId: string, opcoes: MidiaDiretaOpcoes = {}): Promise<string> {
  const id: string = randomUUID();
  const tipo = opcoes.tipo ?? "image";
  const origem = opcoes.origem ?? "legado";
  await connection.collection<{ _id: Types.ObjectId; __v: number; midias: MidiaBruta[] }>("produtos").updateOne(
    { _id: new Types.ObjectId(produtoId) },
    {
      $push: {
        midias: {
          _id: id,
          tipo,
          chave: origem === "legado" ? null : `products/${produtoId}/${id}.${tipo === "image" ? "jpg" : "mp4"}`,
          url: opcoes.url ?? `https://externo.exemplo.com/${id}.${tipo === "image" ? "jpg" : "mp4"}`,
          contentType: null,
          tamanho: null,
          nomeOriginal: null,
          origem,
          varianteId: opcoes.varianteId ? new Types.ObjectId(opcoes.varianteId) : null,
          ordem: opcoes.ordem ?? 0,
          criadoEm: new Date(),
          criadoPor: null,
        },
      },
      $inc: { __v: 1 },
    },
  );
  return id;
}
