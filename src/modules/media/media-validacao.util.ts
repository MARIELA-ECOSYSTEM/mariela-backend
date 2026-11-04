import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFieldError } from "../../common/types/api-response.interface.js";
import { MIME_PERMITIDOS, ROTULO_TAMANHO_MAXIMO, TAMANHO_MAXIMO_BYTES, TODOS_OS_MIME_PERMITIDOS, type TipoMidia } from "./media.constants.js";

export interface ArquivoDeclarado {
  fileName: string;
  contentType: string;
  kind: TipoMidia;
  size: number;
}

/**
 * Regras cruzadas do arquivo declarado (MIME × `kind`, extensão × MIME, limite por tipo) — única implementação,
 * usada pelo endpoint antigo (Fase 40) e pela solicitação de upload da galeria (Fase 60.1). Devolve a extensão
 * canônica usada na chave do objeto.
 */
export function validarArquivoDeclarado(arquivo: ArquivoDeclarado): { extensao: string } {
  const erros: ApiFieldError[] = [];
  const extensoesDoMime = MIME_PERMITIDOS[arquivo.kind]?.[arquivo.contentType];

  if (!TODOS_OS_MIME_PERMITIDOS.includes(arquivo.contentType)) {
    erros.push({ field: "contentType", message: `Tipo de arquivo não permitido. Use: ${TODOS_OS_MIME_PERMITIDOS.join(", ")}.` });
  } else if (!extensoesDoMime) {
    erros.push({ field: "kind", message: `O tipo de arquivo "${arquivo.contentType}" não corresponde a "${arquivo.kind}".` });
  } else {
    const nome = arquivo.fileName.trim();
    const extensaoInformada = nome.includes(".") ? nome.slice(nome.lastIndexOf(".") + 1).toLowerCase() : "";
    if (!extensoesDoMime.includes(extensaoInformada)) {
      erros.push({ field: "fileName", message: `A extensão do arquivo não corresponde a "${arquivo.contentType}" (esperado: .${extensoesDoMime.join(", .")}).` });
    }
  }

  const limite = TAMANHO_MAXIMO_BYTES[arquivo.kind];
  if (limite !== undefined && arquivo.size > limite) {
    erros.push({ field: "size", message: `Arquivo excede o limite de ${ROTULO_TAMANHO_MAXIMO[arquivo.kind]} para ${arquivo.kind === "image" ? "imagens" : "vídeos"}.` });
  }

  if (erros.length > 0) throw ApiException.validation("Dados inválidos.", erros);
  return { extensao: extensoesDoMime![0]! };
}

function comecaCom(bytes: Uint8Array, assinatura: readonly number[], deslocamento = 0): boolean {
  return bytes.length >= deslocamento + assinatura.length && assinatura.every((byte, indice) => bytes[deslocamento + indice] === byte);
}

const ASCII = (texto: string): number[] => [...texto].map((caractere) => caractere.charCodeAt(0));

/**
 * Fase 60.1 — confere a assinatura REAL do formato nos primeiros bytes do objeto (o R2 não inspeciona conteúdo e o
 * `Content-Type` é só o que o cliente declarou): JPEG `FF D8 FF`, PNG `89 50 4E 47`, GIF `GIF8`, WebP `RIFF`+`WEBP`
 * (deslocamento 8), MP4 `ftyp` no deslocamento 4.
 */
export function assinaturaDoFormatoConfere(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case "image/jpeg":
      return comecaCom(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return comecaCom(bytes, [0x89, 0x50, 0x4e, 0x47]);
    case "image/gif":
      return comecaCom(bytes, ASCII("GIF8"));
    case "image/webp":
      return comecaCom(bytes, ASCII("RIFF")) && comecaCom(bytes, ASCII("WEBP"), 8);
    case "video/mp4":
      return comecaCom(bytes, ASCII("ftyp"), 4);
    default:
      return false;
  }
}
