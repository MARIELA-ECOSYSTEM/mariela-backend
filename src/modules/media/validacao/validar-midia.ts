import { decodificarImagem } from "./imagem.decodificacao.js";
import { validarEstruturaGif } from "./gif.estrutura.js";
import { validarEstruturaJpeg } from "./jpeg.estrutura.js";
import { validarEstruturaMp4 } from "./mp4.estrutura.js";
import { validarEstruturaPng } from "./png.estrutura.js";
import { BYTES_MAXIMOS_VALIDACAO, LIMITES_VALIDACAO_MIDIA } from "./validacao-midia.constants.js";
import { RecusaDeMidia, type ResultadoValidacao } from "./validacao-midia.types.js";
import { validarEstruturaWebp } from "./webp.estrutura.js";

type Limites = typeof LIMITES_VALIDACAO_MIDIA;

async function validarOuRecusar(contentType: string, bytes: Uint8Array, limites: Limites): Promise<ResultadoValidacao> {
  switch (contentType) {
    case "image/jpeg": {
      const { largura, altura } = validarEstruturaJpeg(bytes, limites);
      await decodificarImagem(contentType, bytes, limites.maxPixels);
      return { valido: true, formato: "jpeg", largura, altura };
    }
    case "image/png": {
      const { largura, altura } = await validarEstruturaPng(bytes, limites);
      await decodificarImagem(contentType, bytes, limites.maxPixels);
      return { valido: true, formato: "png", largura, altura };
    }
    case "image/webp": {
      const { largura, altura } = validarEstruturaWebp(bytes, limites);
      await decodificarImagem(contentType, bytes, limites.maxPixels);
      return { valido: true, formato: "webp", largura, altura };
    }
    case "image/gif": {
      const { largura, altura, quadros } = validarEstruturaGif(bytes, limites);
      await decodificarImagem(contentType, bytes, limites.maxPixels);
      return { valido: true, formato: "gif", largura, altura, quadros };
    }
    case "video/mp4": {
      const { largura, altura, duracaoSegundos } = validarEstruturaMp4(bytes, limites);
      return { valido: true, formato: "mp4", largura, altura, duracaoSegundos };
    }
    default:
      return { valido: false, motivo: "formato", detalhe: `tipo não suportado: ${contentType}` };
  }
}

/**
 * Fase 60.4.3.4.1 — validação de CONTEÚDO de uma mídia: camada A (estrutura do formato, limites, codecs, animação,
 * dados extras) e, para imagens, camada B (decodificação real com `Bun.Image`) — nessa ordem, parando na primeira
 * recusa. Pura (sem I/O além do decodificador); executada no subprocesso isolado (`validador-midia.processo.ts`).
 *
 * Recusas de conteúdo voltam como `{ valido: false }`. Qualquer outro erro é relançado: é falha do validador (503),
 * nunca "arquivo inválido".
 */
export async function validarConteudoDeMidia(contentType: string, bytes: Uint8Array, limites: Limites = LIMITES_VALIDACAO_MIDIA): Promise<ResultadoValidacao> {
  if (bytes.length === 0) return { valido: false, motivo: "estrutura", detalhe: "arquivo vazio" };
  if (bytes.length > BYTES_MAXIMOS_VALIDACAO) return { valido: false, motivo: "estrutura", detalhe: "arquivo acima do teto de validação" };
  try {
    return await validarOuRecusar(contentType, bytes, limites);
  } catch (erro) {
    if (erro instanceof RecusaDeMidia) return { valido: false, motivo: erro.motivo, detalhe: erro.detalhe };
    throw erro;
  }
}
