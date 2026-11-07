import { Bytes, exigirDimensoes, recusa } from "./bytes.util.js";
import { LIMITES_VALIDACAO_MIDIA } from "./validacao-midia.constants.js";

type Limites = typeof LIMITES_VALIDACAO_MIDIA;

/**
 * Decodifica o LZW de um quadro CONTANDO os índices emitidos (sem guardar pixels): o custo é proporcional aos dados
 * comprimidos e a memória é constante. Devolve a quantidade de pixels produzida até o código EOI; recusa fluxo inválido,
 * fluxo sem EOI e qualquer emissão além de `pixelsDoQuadro`.
 */
function pixelsDoFluxoLzw(dados: Uint8Array, tamanhoMinimoCodigo: number, pixelsDoQuadro: number): number {
  const limpar = 1 << tamanhoMinimoCodigo;
  const fimDoFluxo = limpar + 1;
  const comprimento = new Int32Array(4096);
  for (let i = 0; i < limpar; i += 1) comprimento[i] = 1;
  let tamanhoCodigo = tamanhoMinimoCodigo + 1;
  let proximo = fimDoFluxo + 1;
  let anterior = -1;
  let acumulado = 0;
  let bits = 0;
  let emitidos = 0;
  for (let i = 0; i < dados.length; i += 1) {
    acumulado |= dados[i]! << bits;
    bits += 8;
    while (bits >= tamanhoCodigo) {
      const codigo = acumulado & ((1 << tamanhoCodigo) - 1);
      acumulado >>>= tamanhoCodigo;
      bits -= tamanhoCodigo;
      if (codigo === limpar) {
        tamanhoCodigo = tamanhoMinimoCodigo + 1;
        proximo = fimDoFluxo + 1;
        anterior = -1;
        continue;
      }
      if (codigo === fimDoFluxo) return emitidos;
      let tamanho: number;
      if (codigo < limpar || (codigo > fimDoFluxo && codigo < proximo)) tamanho = comprimento[codigo]!;
      else if (codigo === proximo && anterior !== -1) tamanho = comprimento[anterior]! + 1;
      else throw recusa("estrutura", "GIF: código LZW inválido");
      emitidos += tamanho;
      if (emitidos > pixelsDoQuadro) throw recusa("estrutura", "GIF: quadro com mais pixels do que as dimensões declaram");
      if (anterior !== -1 && proximo < 4096) {
        comprimento[proximo] = comprimento[anterior]! + 1;
        proximo += 1;
        if (proximo === 1 << tamanhoCodigo && tamanhoCodigo < 12) tamanhoCodigo += 1;
      }
      anterior = codigo;
    }
  }
  throw recusa("estrutura", "GIF: fluxo LZW sem código de fim");
}

/**
 * Fase 60.4.3.4.1 — estrutura do GIF: cabeçalho GIF87a/GIF89a; Logical Screen Descriptor; tabelas de cor com o
 * tamanho certo; extensões com sub-blocos completos; cada Image Descriptor dentro da tela lógica e com LZW válido que
 * produz EXATAMENTE largura × altura pixels; no máximo `maxQuadrosGif` quadros; trailer 0x3B no FIM EXATO do arquivo.
 * O `Bun.Image` decodifica só o 1º quadro — esta é a única proteção dos quadros seguintes.
 */
export function validarEstruturaGif(b: Uint8Array, limites: Limites = LIMITES_VALIDACAO_MIDIA): { largura: number; altura: number; quadros: number } {
  const bytes = new Bytes(b);
  const versao = bytes.tamanho >= 6 ? bytes.ascii(0, 6) : "";
  if (versao !== "GIF87a" && versao !== "GIF89a") throw recusa("formato", "GIF: cabeçalho inválido");
  const largura = bytes.u16le(6, "GIF: tela lógica");
  const altura = bytes.u16le(8, "GIF: tela lógica");
  exigirDimensoes("GIF", largura, altura, limites);
  const flagsTela = bytes.u8(10, "GIF: tela lógica");
  let p = 13;
  if (flagsTela & 0x80) p += 3 * (1 << ((flagsTela & 7) + 1));
  if (p > bytes.tamanho) throw recusa("estrutura", "GIF: tabela de cores global truncada");

  /** Avança pelos sub-blocos até o terminador (0); devolve os dados concatenados quando pedido. */
  const subBlocos = (coletar: boolean): Uint8Array => {
    const partes: Uint8Array[] = [];
    for (;;) {
      const n = bytes.u8(p, "GIF: sub-bloco");
      p += 1;
      if (n === 0) break;
      const parte = bytes.fatia(p, p + n, "GIF: sub-bloco");
      if (coletar) partes.push(parte);
      p += n;
    }
    return coletar ? Buffer.concat(partes) : new Uint8Array(0);
  };

  let quadros = 0;
  let temTrailer = false;
  while (p < bytes.tamanho) {
    const bloco = bytes.u8(p);
    p += 1;
    if (bloco === 0x3b) {
      temTrailer = true;
      break;
    }
    if (bloco === 0x21) {
      bytes.u8(p, "GIF: rótulo de extensão");
      p += 1;
      subBlocos(false);
      continue;
    }
    if (bloco !== 0x2c) throw recusa("estrutura", `GIF: bloco desconhecido 0x${bloco.toString(16)} no offset ${p - 1}`);
    const x = bytes.u16le(p, "GIF: descritor de imagem");
    const y = bytes.u16le(p + 2, "GIF: descritor de imagem");
    const larguraQuadro = bytes.u16le(p + 4, "GIF: descritor de imagem");
    const alturaQuadro = bytes.u16le(p + 6, "GIF: descritor de imagem");
    const flags = bytes.u8(p + 8, "GIF: descritor de imagem");
    p += 9;
    if (larguraQuadro === 0 || alturaQuadro === 0 || x + larguraQuadro > largura || y + alturaQuadro > altura) throw recusa("estrutura", "GIF: quadro fora da tela lógica");
    if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
    const tamanhoMinimoCodigo = bytes.u8(p, "GIF: dados de imagem");
    p += 1;
    if (tamanhoMinimoCodigo < 2 || tamanhoMinimoCodigo > 8) throw recusa("estrutura", "GIF: tamanho mínimo de código LZW inválido");
    quadros += 1;
    if (quadros > limites.maxQuadrosGif) throw recusa("quadros", `GIF: mais de ${limites.maxQuadrosGif} quadros`);
    const pixels = pixelsDoFluxoLzw(subBlocos(true), tamanhoMinimoCodigo, larguraQuadro * alturaQuadro);
    if (pixels !== larguraQuadro * alturaQuadro) throw recusa("estrutura", `GIF: quadro ${quadros} incompleto (${pixels} de ${larguraQuadro * alturaQuadro} pixels)`);
  }
  if (!temTrailer) throw recusa("estrutura", "GIF: sem trailer (truncado)");
  if (!quadros) throw recusa("estrutura", "GIF: nenhum quadro");
  if (p !== bytes.tamanho) throw recusa("dados-extras", `GIF: ${bytes.tamanho - p} bytes após o trailer`);
  return { largura, altura, quadros };
}
