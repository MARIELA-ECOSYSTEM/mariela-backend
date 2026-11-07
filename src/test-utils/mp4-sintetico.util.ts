import { FIXTURES_MIDIA, fixtureDeMidia } from "./media-storage-falso.util.js";

/**
 * Fase 60.4.3.4.1 — monta MP4 PROGRESSIVOS sintéticos para os testes da validação estrutural, a partir do fixture
 * real `mp4-h264-progressivo.mp4` (1 amostra H.264): permite trocar o codec do vídeo, a duração, acrescentar uma
 * trilha de áudio (AAC ou outro codec) ou uma trilha de outro tipo. Os bytes de áudio são opacos (o validador não
 * decodifica áudio).
 */
export interface OpcoesMp4Sintetico {
  /** FourCC da entrada de vídeo no `stsd` (padrão `avc1`). */
  codecVideo?: string;
  /** Duração do vídeo em SEGUNDOS gravada no `mdhd` (padrão: a do fixture). */
  duracaoVideoSegundos?: number;
  /** Trilha extra: `soun` com `mp4a`+OTI (AAC = 0x40) ou outro codec; ou outro manipulador (ex.: `text`). */
  trilhaExtra?: { manipulador: string; codec: string; oti?: number };
}

interface Caixa {
  tipo: string;
  inicio: number;
  dados: number;
  fim: number;
}

const ascii = (texto: string) => new Uint8Array([...texto].map((c) => c.charCodeAt(0)));
const be16 = (v: number) => new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
const be32 = (v: number) => {
  const saida = new Uint8Array(4);
  new DataView(saida.buffer).setUint32(0, v);
  return saida;
};
const juntar = (...partes: Uint8Array[]) => new Uint8Array(Buffer.concat(partes));
const zeros = (n: number) => new Uint8Array(n);
export const caixaMp4 = (tipo: string, ...conteudo: Uint8Array[]) => {
  const corpo = juntar(...conteudo);
  return juntar(be32(corpo.length + 8), ascii(tipo), corpo);
};

function filhas(b: Uint8Array, inicio: number, fim: number): Caixa[] {
  const vista = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const saida: Caixa[] = [];
  let p = inicio;
  while (p + 8 <= fim) {
    const tamanho = vista.getUint32(p);
    saida.push({ tipo: String.fromCharCode(...b.subarray(p + 4, p + 8)), inicio: p, dados: p + 8, fim: p + tamanho });
    p += tamanho;
  }
  return saida;
}
function achar(lista: Caixa[], tipo: string): Caixa {
  const caixa = lista.find((item) => item.tipo === tipo);
  if (!caixa) throw new Error(`fixture MP4 sem ${tipo}`);
  return caixa;
}

/** Trilha (sem o `stco`, que depende do offset final): tkhd, mdhd, hdlr, cabeçalho de mídia e stsd. */
function trilhaExtra(id: number, manipulador: string, codec: string, oti: number | undefined, amostras: number[], duracao: number) {
  const tkhd = caixaMp4("tkhd", be32(0x00000007), zeros(8), be32(id), zeros(4), be32(duracao), zeros(8), zeros(8), zeros(36), zeros(8));
  const mdhd = caixaMp4("mdhd", zeros(4), zeros(8), be32(1000), be32(duracao), zeros(4));
  const hdlr = caixaMp4("hdlr", zeros(4), zeros(4), ascii(manipulador), zeros(12), zeros(1));
  const smhd = caixaMp4("smhd", zeros(8));
  const esds =
    oti === undefined
      ? new Uint8Array(0)
      : caixaMp4(
          "esds",
          zeros(4),
          new Uint8Array([0x03, 25, 0x00, 0x01, 0x00, 0x04, 17, oti, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02]),
        );
  const entrada = caixaMp4(codec, zeros(6), be16(1), zeros(8), be16(2), be16(16), zeros(4), be32(44100 * 65536), esds);
  const stsd = caixaMp4("stsd", zeros(4), be32(1), entrada);
  const stts = caixaMp4("stts", zeros(4), be32(1), be32(amostras.length), be32(Math.max(1, Math.floor(duracao / amostras.length))));
  const stsc = caixaMp4("stsc", zeros(4), be32(1), be32(1), be32(amostras.length), be32(1));
  const stsz = caixaMp4("stsz", zeros(4), be32(0), be32(amostras.length), ...amostras.map(be32));
  return (offset: number) => caixaMp4("trak", tkhd, caixaMp4("mdia", mdhd, hdlr, caixaMp4("minf", smhd, caixaMp4("dinf", caixaMp4("dref", zeros(4), be32(0))), caixaMp4("stbl", stsd, stts, stsc, stsz, caixaMp4("stco", zeros(4), be32(1), be32(offset))))));
}

export function mp4Sintetico(opcoes: OpcoesMp4Sintetico = {}): Uint8Array {
  const f = fixtureDeMidia(FIXTURES_MIDIA.mp4Progressivo);
  const vista = new DataView(f.buffer, f.byteOffset, f.byteLength);
  const topo = filhas(f, 0, f.length);
  const moov = filhas(f, achar(topo, "moov").dados, achar(topo, "moov").fim);
  const trak = filhas(f, achar(moov, "trak").dados, achar(moov, "trak").fim);
  const mdia = filhas(f, achar(trak, "mdia").dados, achar(trak, "mdia").fim);
  const minf = filhas(f, achar(mdia, "minf").dados, achar(mdia, "minf").fim);
  const stbl = filhas(f, achar(minf, "stbl").dados, achar(minf, "stbl").fim);
  const mdat = achar(topo, "mdat");
  const amostraVideo = f.slice(mdat.dados, mdat.fim);
  const copia = (caixa: Caixa) => f.slice(caixa.inicio, caixa.fim);

  const mdhd = copia(achar(mdia, "mdhd"));
  // mdhd versão 1 (64 bits): timescale em +20 e duração (8 bytes) em +24 dos dados; versão 0: +12 e +16 (4 bytes).
  const versao1 = mdhd[8] === 1;
  const timescale = vista.getUint32(achar(mdia, "mdhd").dados + (versao1 ? 20 : 12));
  if (opcoes.duracaoVideoSegundos !== undefined) {
    const duracao = Math.round(opcoes.duracaoVideoSegundos * timescale);
    const vistaMdhd = new DataView(mdhd.buffer);
    if (versao1) vistaMdhd.setBigUint64(8 + 24, BigInt(duracao));
    else vistaMdhd.setUint32(8 + 16, duracao);
  }
  const stsd = copia(achar(stbl, "stsd"));
  if (opcoes.codecVideo) stsd.set(ascii(opcoes.codecVideo), 8 + 8 + 4);

  const amostrasExtras = opcoes.trilhaExtra ? [32, 32] : [];
  const extra = opcoes.trilhaExtra ? trilhaExtra(2, opcoes.trilhaExtra.manipulador, opcoes.trilhaExtra.codec, opcoes.trilhaExtra.oti, amostrasExtras, 50) : null;
  const montar = (offsetVideo: number) => {
    const stblVideo = caixaMp4("stbl", stsd, copia(achar(stbl, "stts")), copia(achar(stbl, "stsc")), copia(achar(stbl, "stsz")), caixaMp4("stco", zeros(4), be32(1), be32(offsetVideo)));
    const trakVideo = caixaMp4("trak", copia(achar(trak, "tkhd")), caixaMp4("mdia", mdhd, copia(achar(mdia, "hdlr")), caixaMp4("minf", copia(achar(minf, "vmhd")), copia(achar(minf, "dinf")), stblVideo)));
    return caixaMp4("moov", copia(achar(moov, "mvhd")), trakVideo, ...(extra ? [extra(offsetVideo + amostraVideo.length)] : []));
  };
  const ftyp = copia(achar(topo, "ftyp"));
  const offsetVideo = ftyp.length + montar(0).length + 8;
  const dadosExtras = new Uint8Array(amostrasExtras.reduce((soma, n) => soma + n, 0)).fill(0x21);
  return juntar(ftyp, montar(offsetVideo), caixaMp4("mdat", amostraVideo, dadosExtras));
}
