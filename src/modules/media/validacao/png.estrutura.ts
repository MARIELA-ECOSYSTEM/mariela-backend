import { createInflate } from "node:zlib";
import { Bytes, crc32, exigirDimensoes, recusa } from "./bytes.util.js";
import { LIMITES_VALIDACAO_MIDIA } from "./validacao-midia.constants.js";

type Limites = typeof LIMITES_VALIDACAO_MIDIA;

const ASSINATURA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CANAIS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PROFUNDIDADES: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
/** Chunks exclusivos de APNG (animação) — APNG é recusado nesta fase. */
const CHUNKS_APNG = new Set(["acTL", "fcTL", "fdAT"]);
const CHUNKS_CRITICOS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const PASSOS_ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** Bytes brutos (com o byte de filtro de cada linha) que o IDAT descomprimido precisa ter, exatamente. */
function bytesBrutosEsperados(largura: number, altura: number, bitsPorPixel: number, entrelacado: boolean): number {
  const linha = (larguraLinha: number) => (larguraLinha === 0 ? 0 : 1 + Math.ceil((larguraLinha * bitsPorPixel) / 8));
  if (!entrelacado) return altura * linha(largura);
  let total = 0;
  for (const [x0, y0, dx, dy] of PASSOS_ADAM7) {
    const larguraPasso = Math.ceil((largura - x0) / dx);
    const alturaPasso = Math.ceil((altura - y0) / dy);
    if (larguraPasso > 0 && alturaPasso > 0) total += alturaPasso * linha(larguraPasso);
  }
  return total;
}

/**
 * Descomprime o zlib dos IDAT em STREAM, descartando a saída e só contando bytes (memória constante — a auditoria
 * mediu +213 MiB com `inflateSync` numa imagem de 36 MP e +15 MiB em stream). Para assim que passar de `limite`.
 */
function contarBytesDescomprimidos(partes: readonly Uint8Array[], limite: number): Promise<number> {
  return new Promise<number>((resolver, rejeitar) => {
    const inflate = createInflate();
    let total = 0;
    let concluido = false;
    const concluir = (acao: () => void) => {
      if (concluido) return;
      concluido = true;
      acao();
    };
    inflate.on("data", (pedaco: Buffer) => {
      total += pedaco.length;
      if (total > limite) {
        concluir(() => resolver(total));
        inflate.destroy();
      }
    });
    inflate.on("error", (erro: Error) => concluir(() => rejeitar(recusa("estrutura", `PNG: fluxo zlib inválido (${erro.message})`))));
    inflate.on("end", () => concluir(() => resolver(total)));
    for (const parte of partes) inflate.write(parte);
    inflate.end();
  });
}

/**
 * Fase 60.4.3.4.1 — estrutura do PNG: assinatura completa; chunks com CRC-32 conferido em TODOS; IHDR primeiro (13
 * bytes, combinação válida); PLTE obrigatório no tipo 3; IDAT contíguos; chunk crítico desconhecido recusado; IEND
 * vazio e no FIM EXATO do arquivo; zlib íntegro (Adler-32) e com exatamente o tamanho bruto esperado. APNG recusado.
 * Chunks auxiliares (minúsculos, ex.: tEXt/iCCP/eXIf) são aceitos: são parte do formato e têm CRC.
 */
export async function validarEstruturaPng(b: Uint8Array, limites: Limites = LIMITES_VALIDACAO_MIDIA): Promise<{ largura: number; altura: number }> {
  const bytes = new Bytes(b);
  if (bytes.tamanho < 8 || ASSINATURA_PNG.some((byte, indice) => b[indice] !== byte)) throw recusa("formato", "PNG: assinatura inválida");
  let p = 8;
  let chunks = 0;
  let largura = 0;
  let altura = 0;
  let bitsPorPixel = 0;
  let entrelacado = false;
  let tipoCor = -1;
  let temPaleta = false;
  let idatEncerrado = false;
  let temIend = false;
  const idat: Uint8Array[] = [];

  while (p < bytes.tamanho) {
    chunks += 1;
    if (chunks > limites.maxChunksPng) throw recusa("estrutura", "PNG: chunks demais");
    const tamanho = bytes.u32be(p, "PNG: cabeçalho de chunk");
    const tipo = bytes.ascii(p + 4, 4, "PNG: tipo de chunk");
    if (tamanho > 0x7fffffff || p + 12 + tamanho > bytes.tamanho) throw recusa("estrutura", `PNG: chunk ${tipo} ultrapassa o arquivo`);
    if (!/^[A-Za-z]{4}$/.test(tipo)) throw recusa("estrutura", "PNG: tipo de chunk inválido");
    if (crc32(b, p + 4, p + 8 + tamanho) !== bytes.u32be(p + 8 + tamanho)) throw recusa("estrutura", `PNG: CRC inválido no chunk ${tipo}`);
    const dados = p + 8;

    if (chunks === 1 && tipo !== "IHDR") throw recusa("estrutura", "PNG: o primeiro chunk não é IHDR");
    if (CHUNKS_APNG.has(tipo)) throw recusa("animacao", "PNG: APNG (animado)");
    if (tipo === "IHDR") {
      if (chunks !== 1 || tamanho !== 13) throw recusa("estrutura", "PNG: IHDR inválido");
      largura = bytes.u32be(dados);
      altura = bytes.u32be(dados + 4);
      const profundidade = bytes.u8(dados + 8);
      tipoCor = bytes.u8(dados + 9);
      const metodoEntrelacamento = bytes.u8(dados + 12);
      if (!PROFUNDIDADES[tipoCor]?.includes(profundidade) || bytes.u8(dados + 10) !== 0 || bytes.u8(dados + 11) !== 0 || metodoEntrelacamento > 1) {
        throw recusa("estrutura", "PNG: IHDR com combinação inválida");
      }
      exigirDimensoes("PNG", largura, altura, limites);
      bitsPorPixel = (CANAIS[tipoCor] ?? 0) * profundidade;
      entrelacado = metodoEntrelacamento === 1;
    } else if (tipo === "IDAT") {
      if (idatEncerrado) throw recusa("estrutura", "PNG: IDAT não contíguos");
      idat.push(b.subarray(dados, dados + tamanho));
    } else if (tipo === "IEND") {
      if (tamanho !== 0) throw recusa("estrutura", "PNG: IEND com dados");
      temIend = true;
      p += 12;
      break;
    } else {
      if (idat.length) idatEncerrado = true;
      if (tipo === "PLTE") temPaleta = true;
      else if (tipo.charCodeAt(0) < 0x61 && !CHUNKS_CRITICOS.has(tipo)) throw recusa("estrutura", `PNG: chunk crítico desconhecido ${tipo}`);
    }
    p += 12 + tamanho;
  }

  if (!temIend) throw recusa("estrutura", "PNG: sem IEND");
  if (!idat.length) throw recusa("estrutura", "PNG: sem IDAT");
  if (tipoCor === 3 && !temPaleta) throw recusa("estrutura", "PNG: paleta ausente");
  if (p !== bytes.tamanho) throw recusa("dados-extras", `PNG: ${bytes.tamanho - p} bytes após o IEND`);

  const esperado = bytesBrutosEsperados(largura, altura, bitsPorPixel, entrelacado);
  const obtido = await contarBytesDescomprimidos(idat, esperado);
  if (obtido !== esperado) throw recusa("estrutura", `PNG: dados descomprimidos (${obtido}) diferentes do esperado (${esperado})`);
  return { largura, altura };
}
