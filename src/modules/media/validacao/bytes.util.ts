import { RecusaDeMidia, type MotivoRecusa } from "./validacao-midia.types.js";

/**
 * Fase 60.4.3.4.1 — leitura de inteiros com verificação de limites. Toda leitura fora do buffer é uma recusa
 * estrutural (arquivo truncado/inconsistente), nunca `undefined`/`NaN` silencioso.
 */
export class Bytes {
  constructor(readonly b: Uint8Array) {}

  get tamanho(): number {
    return this.b.length;
  }

  private exigir(p: number, n: number, contexto: string): void {
    if (!Number.isInteger(p) || p < 0 || p + n > this.b.length) throw recusa("estrutura", `${contexto}: leitura fora do arquivo (offset ${p})`);
  }

  u8(p: number, contexto = "leitura"): number {
    this.exigir(p, 1, contexto);
    return this.b[p]!;
  }

  u16be(p: number, contexto = "leitura"): number {
    this.exigir(p, 2, contexto);
    return (this.b[p]! << 8) | this.b[p + 1]!;
  }

  u32be(p: number, contexto = "leitura"): number {
    this.exigir(p, 4, contexto);
    return this.b[p]! * 0x1000000 + ((this.b[p + 1]! << 16) | (this.b[p + 2]! << 8) | this.b[p + 3]!);
  }

  i32be(p: number, contexto = "leitura"): number {
    const valor = this.u32be(p, contexto);
    return valor >= 0x80000000 ? valor - 0x100000000 : valor;
  }

  u64be(p: number, contexto = "leitura"): number {
    const alto = this.u32be(p, contexto);
    const baixo = this.u32be(p + 4, contexto);
    const valor = alto * 0x100000000 + baixo;
    if (!Number.isSafeInteger(valor)) throw recusa("estrutura", `${contexto}: valor de 64 bits fora do intervalo seguro`);
    return valor;
  }

  u16le(p: number, contexto = "leitura"): number {
    this.exigir(p, 2, contexto);
    return this.b[p]! | (this.b[p + 1]! << 8);
  }

  u24le(p: number, contexto = "leitura"): number {
    this.exigir(p, 3, contexto);
    return this.b[p]! | (this.b[p + 1]! << 8) | (this.b[p + 2]! << 16);
  }

  u32le(p: number, contexto = "leitura"): number {
    this.exigir(p, 4, contexto);
    return (this.b[p]! | (this.b[p + 1]! << 8) | (this.b[p + 2]! << 16)) + this.b[p + 3]! * 0x1000000;
  }

  ascii(p: number, n: number, contexto = "leitura"): string {
    this.exigir(p, n, contexto);
    let texto = "";
    for (let i = p; i < p + n; i += 1) texto += String.fromCharCode(this.b[i]!);
    return texto;
  }

  fatia(inicio: number, fim: number, contexto = "leitura"): Uint8Array {
    this.exigir(inicio, fim - inicio, contexto);
    return this.b.subarray(inicio, fim);
  }
}

export function recusa(motivo: MotivoRecusa, detalhe: string): RecusaDeMidia {
  return new RecusaDeMidia(motivo, detalhe);
}

const TABELA_CRC32 = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

/** CRC-32 (ISO-HDLC, o do PNG) de `b[inicio, fim)`. */
export function crc32(b: Uint8Array, inicio: number, fim: number): number {
  let c = 0xffffffff;
  for (let i = inicio; i < fim; i += 1) c = TABELA_CRC32[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Confere largura/altura contra os limites aprovados (lado e pixels). */
export function exigirDimensoes(formato: string, largura: number, altura: number, limites: { maxPixels: number; maxLado: number }): void {
  if (largura <= 0 || altura <= 0) throw recusa("estrutura", `${formato}: dimensões inválidas ${largura}x${altura}`);
  if (largura > limites.maxLado || altura > limites.maxLado || largura * altura > limites.maxPixels) {
    throw recusa("dimensoes", `${formato}: dimensões ${largura}x${altura} acima do limite`);
  }
}
