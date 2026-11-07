import { Bytes, exigirDimensoes, recusa } from "./bytes.util.js";
import { LIMITES_VALIDACAO_MIDIA } from "./validacao-midia.constants.js";

type Limites = typeof LIMITES_VALIDACAO_MIDIA;

interface JpegPercorrido {
  /** Posição logo depois do EOI. */
  fim: number;
  largura: number;
  altura: number;
  /** A imagem declara um índice Multi-Picture Format (APP2 "MPF\0") — única origem aceita de imagens anexas. */
  declaraMpf: boolean;
}

/** SOF0 (baseline), SOF1 (sequencial estendido) e SOF2 (progressivo) — os processos que os navegadores exibem. */
const SOF_SUPORTADOS = new Set([0xc0, 0xc1, 0xc2]);

function ehSof(marcador: number): boolean {
  return marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc;
}

/** Percorre UMA imagem JPEG a partir de `inicio` (SOI) até o EOI, conferindo segmentos, SOF único e dados entrópicos. */
function percorrerJpeg(bytes: Bytes, inicio: number, limites: Limites): JpegPercorrido {
  if (bytes.u8(inicio, "JPEG") !== 0xff || bytes.u8(inicio + 1, "JPEG") !== 0xd8) throw recusa("estrutura", `JPEG: sem SOI no offset ${inicio}`);
  let p = inicio + 2;
  let sofs = 0;
  let scans = 0;
  let largura = 0;
  let altura = 0;
  let declaraMpf = false;
  for (;;) {
    if (p >= bytes.tamanho) throw recusa("estrutura", "JPEG: truncado (sem EOI)");
    if (bytes.u8(p) !== 0xff) throw recusa("estrutura", `JPEG: dados onde era esperado um marcador (offset ${p})`);
    while (p < bytes.tamanho && bytes.u8(p) === 0xff) p += 1;
    const marcador = bytes.u8(p, "JPEG: marcador");
    p += 1;
    if (marcador === 0xd9) break;
    if ((marcador >= 0xd0 && marcador <= 0xd7) || marcador === 0x01) continue;
    if (marcador === 0xd8 || marcador === 0x00) throw recusa("estrutura", `JPEG: marcador inesperado 0x${marcador.toString(16)}`);

    const tamanho = bytes.u16be(p, "JPEG: tamanho do segmento");
    if (tamanho < 2 || p + tamanho > bytes.tamanho) throw recusa("estrutura", "JPEG: segmento ultrapassa o arquivo");

    if (ehSof(marcador)) {
      sofs += 1;
      if (sofs > 1) throw recusa("estrutura", "JPEG: mais de um SOF (hierárquico)");
      if (!SOF_SUPORTADOS.has(marcador)) throw recusa("formato", `JPEG: processo SOF${(marcador - 0xc0).toString(16)} não suportado`);
      altura = bytes.u16be(p + 3);
      largura = bytes.u16be(p + 5);
      const componentes = bytes.u8(p + 7);
      if ((componentes !== 1 && componentes !== 3 && componentes !== 4) || tamanho !== 8 + 3 * componentes) throw recusa("estrutura", "JPEG: SOF inconsistente");
      exigirDimensoes("JPEG", largura, altura, limites);
    } else if (marcador === 0xe2 && tamanho >= 6 && bytes.ascii(p + 2, 4) === "MPF\0") {
      declaraMpf = true;
    }

    if (marcador === 0xda) {
      if (!sofs) throw recusa("estrutura", "JPEG: SOS antes do SOF");
      scans += 1;
      if (scans > limites.maxScansJpeg) throw recusa("estrutura", "JPEG: scans demais");
      p += tamanho;
      // Dados entrópicos até o próximo marcador real (FF00 = byte escapado; RSTn = reinício; FF FF = enchimento).
      for (;;) {
        if (p + 1 >= bytes.tamanho) throw recusa("estrutura", "JPEG: truncado nos dados da imagem");
        if (bytes.u8(p) === 0xff) {
          const seguinte = bytes.u8(p + 1);
          if (seguinte === 0x00 || (seguinte >= 0xd0 && seguinte <= 0xd7)) {
            p += 2;
            continue;
          }
          if (seguinte === 0xff) {
            p += 1;
            continue;
          }
          break;
        }
        p += 1;
      }
      continue;
    }
    p += tamanho;
  }
  if (!sofs || !scans) throw recusa("estrutura", "JPEG: sem SOF ou sem SOS");
  return { fim: p, largura, altura, declaraMpf };
}

/**
 * Fase 60.4.3.4.1 — estrutura do JPEG. Bytes depois do EOI só são aceitos quando a imagem principal declara um
 * índice MPF (Multi-Picture Format, usado por fotos Ultra HDR/gain map e por câmeras com imagens auxiliares) E todo o
 * restante é formado por JPEGs completos e estruturalmente válidos, um após o outro (até `maxImagensAnexasJpeg`).
 * Qualquer outro dado (lixo, ZIP anexado, preenchimento, JPEG truncado) é recusado.
 *
 * Limitações: as imagens anexas são conferidas só estruturalmente (a decodificação real é da principal) e os offsets
 * do índice MPF não são cruzados com as posições encontradas.
 */
export function validarEstruturaJpeg(b: Uint8Array, limites: Limites = LIMITES_VALIDACAO_MIDIA): { largura: number; altura: number; imagensAnexas: number } {
  const bytes = new Bytes(b);
  const principal = percorrerJpeg(bytes, 0, limites);
  let p = principal.fim;
  let anexas = 0;
  if (p < bytes.tamanho && !principal.declaraMpf) throw recusa("dados-extras", `JPEG: ${bytes.tamanho - p} bytes após o EOI sem índice MPF`);
  while (p < bytes.tamanho) {
    anexas += 1;
    if (anexas > limites.maxImagensAnexasJpeg) throw recusa("dados-extras", "JPEG: imagens anexas demais");
    if (bytes.u8(p) !== 0xff || bytes.u8(p + 1, "JPEG anexo") !== 0xd8) throw recusa("dados-extras", `JPEG: dados após o EOI que não são uma imagem JPEG (offset ${p})`);
    p = percorrerJpeg(bytes, p, limites).fim;
  }
  return { largura: principal.largura, altura: principal.altura, imagensAnexas: anexas };
}
