import { Bytes, exigirDimensoes, recusa } from "./bytes.util.js";
import { LIMITES_VALIDACAO_MIDIA } from "./validacao-midia.constants.js";

type Limites = typeof LIMITES_VALIDACAO_MIDIA;

/** Chunks de metadados aceitos no formato estendido (VP8X): transparência, perfil de cor, EXIF e XMP. */
const CHUNKS_AUXILIARES = new Set(["ALPH", "ICCP", "EXIF", "XMP "]);
const FLAG_ANIMACAO_VP8X = 0x02;

/**
 * Fase 60.4.3.4.1 — estrutura do WebP ESTÁTICO: `RIFF` cujo tamanho declarado + 8 é EXATAMENTE o tamanho do arquivo
 * (sobra = dados extras; falta = truncado); `WEBP`; chunks com padding par dentro do arquivo; `VP8X` só como primeiro
 * chunk; exatamente UM chunk de imagem (`VP8 ` com quadro-chave e start code `9D 01 2A`, ou `VP8L` com a assinatura
 * `0x2F`); no formato estendido, dimensões da tela iguais às do bitstream. WebP animado (flag do VP8X, `ANIM`/`ANMF`)
 * é recusado. Qualquer chunk desconhecido é recusado.
 */
export function validarEstruturaWebp(b: Uint8Array, limites: Limites = LIMITES_VALIDACAO_MIDIA): { largura: number; altura: number } {
  const bytes = new Bytes(b);
  if (bytes.tamanho < 12 || bytes.ascii(0, 4) !== "RIFF" || bytes.ascii(8, 4) !== "WEBP") throw recusa("formato", "WebP: cabeçalho RIFF/WEBP inválido");
  const tamanhoRiff = bytes.u32le(4) + 8;
  if (tamanhoRiff > bytes.tamanho) throw recusa("estrutura", `WebP: RIFF declara ${tamanhoRiff} bytes, o arquivo tem ${bytes.tamanho} (truncado)`);
  if (tamanhoRiff < bytes.tamanho) throw recusa("dados-extras", `WebP: ${bytes.tamanho - tamanhoRiff} bytes após o fim do RIFF`);

  let p = 12;
  let primeiro = true;
  let tela: { largura: number; altura: number } | null = null;
  let imagem: { largura: number; altura: number } | null = null;
  while (p < bytes.tamanho) {
    const tipo = bytes.ascii(p, 4, "WebP: cabeçalho de chunk");
    const tamanho = bytes.u32le(p + 4, "WebP: cabeçalho de chunk");
    const dados = p + 8;
    if (dados + tamanho > bytes.tamanho) throw recusa("estrutura", `WebP: chunk ${tipo} ultrapassa o arquivo`);
    if (tipo === "VP8X") {
      if (!primeiro || tamanho < 10) throw recusa("estrutura", "WebP: VP8X fora de posição ou curto");
      if (bytes.u8(dados) & FLAG_ANIMACAO_VP8X) throw recusa("animacao", "WebP: animado (flag do VP8X)");
      tela = { largura: bytes.u24le(dados + 4) + 1, altura: bytes.u24le(dados + 7) + 1 };
    } else if (tipo === "ANIM" || tipo === "ANMF") {
      throw recusa("animacao", `WebP: animado (chunk ${tipo})`);
    } else if (tipo === "VP8 " || tipo === "VP8L") {
      if (imagem) throw recusa("estrutura", "WebP: mais de um chunk de imagem");
      if (tipo === "VP8 ") {
        if (tamanho < 10 || bytes.u8(dados) & 0x01 || bytes.u8(dados + 3) !== 0x9d || bytes.u8(dados + 4) !== 0x01 || bytes.u8(dados + 5) !== 0x2a) {
          throw recusa("estrutura", "WebP: quadro VP8 inválido");
        }
        imagem = { largura: bytes.u16le(dados + 6) & 0x3fff, altura: bytes.u16le(dados + 8) & 0x3fff };
      } else {
        if (tamanho < 5 || bytes.u8(dados) !== 0x2f) throw recusa("estrutura", "WebP: VP8L inválido");
        const campo = bytes.u32le(dados + 1);
        imagem = { largura: (campo & 0x3fff) + 1, altura: ((campo >>> 14) & 0x3fff) + 1 };
      }
    } else if (!tela || !CHUNKS_AUXILIARES.has(tipo)) {
      throw recusa("estrutura", `WebP: chunk não reconhecido ${JSON.stringify(tipo)}`);
    }
    primeiro = false;
    p = dados + tamanho + (tamanho & 1);
  }
  if (p !== bytes.tamanho) throw recusa("estrutura", "WebP: preenchimento inconsistente");
  if (!imagem) throw recusa("estrutura", "WebP: sem dados de imagem");
  if (tela && (tela.largura !== imagem.largura || tela.altura !== imagem.altura)) throw recusa("estrutura", "WebP: dimensões da tela diferentes das da imagem");
  exigirDimensoes("WebP", imagem.largura, imagem.altura, limites);
  return imagem;
}
