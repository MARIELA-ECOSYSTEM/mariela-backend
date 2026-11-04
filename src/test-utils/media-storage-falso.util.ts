import { randomUUID } from "node:crypto";
import { Types, type Connection } from "mongoose";
import { ApiException } from "../common/exceptions/api.exception.js";
import type { AssinarUploadParams, InspecaoObjeto, MediaStorage } from "../modules/media/media.types.js";

/**
 * Fase 60.1 — storage de mídia FALSO e determinístico para os testes (nenhum teste fala com o R2 real). Simula o
 * bucket em memória: `enviar` faz o papel do `PUT` do cliente; `falhas` liga a indisponibilidade de cada operação
 * (sempre `STORAGE_UNAVAILABLE`, como o provider R2). `exclusoes` registra qualquer exclusão física — nesta fase
 * nenhuma deve acontecer.
 */
export class MediaStorageFalso implements MediaStorage {
  readonly objetos = new Map<string, { bytes: Uint8Array; contentType: string | null; tamanho: number | null }>();
  readonly assinaturas: AssinarUploadParams[] = [];
  readonly exclusoes: string[] = [];
  readonly falhas = { assinar: false, inspecionar: false, ler: false, excluir: false };

  async assinarUpload(params: AssinarUploadParams): Promise<string> {
    if (this.falhas.assinar) throw ApiException.storageUnavailable();
    this.assinaturas.push(params);
    return `https://storage-falso.teste/${params.key}?X-Amz-Signature=falsa`;
  }

  async inspecionarObjeto(key: string): Promise<InspecaoObjeto> {
    if (this.falhas.inspecionar) throw ApiException.storageUnavailable();
    const objeto = this.objetos.get(key);
    return objeto ? { existe: true, tamanho: objeto.tamanho, contentType: objeto.contentType } : { existe: false };
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
    this.objetos.set(key, { bytes, contentType, tamanho });
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

/** Cabeçalhos reais mínimos de cada formato (o resto do arquivo é preenchido com zeros). */
export const CABECALHOS_FORMATO: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/gif": ASCII("GIF89a"),
  "image/webp": [...ASCII("RIFF"), 0x24, 0x00, 0x00, 0x00, ...ASCII("WEBPVP8 ")],
  "video/mp4": [0x00, 0x00, 0x00, 0x18, ...ASCII("ftypmp42")],
  "text/html": ASCII("<!doctype html><script>"),
};

/** Arquivo de `tamanho` bytes cujo início é o cabeçalho real de `formato`. */
export function arquivoDoFormato(formato: string, tamanho = 1024): Uint8Array {
  const bytes = new Uint8Array(tamanho);
  bytes.set((CABECALHOS_FORMATO[formato] ?? []).slice(0, tamanho));
  return bytes;
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
