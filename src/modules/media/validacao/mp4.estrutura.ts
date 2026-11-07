import { Bytes, exigirDimensoes, recusa } from "./bytes.util.js";
import { CODECS_AUDIO_PERMITIDOS, CODECS_VIDEO_PERMITIDOS, LIMITES_VALIDACAO_MIDIA, OTI_AAC } from "./validacao-midia.constants.js";

type Limites = typeof LIMITES_VALIDACAO_MIDIA;

interface Caixa {
  tipo: string;
  inicio: number;
  dados: number;
  fim: number;
}

interface Amostra {
  offset: number;
  tamanho: number;
}

interface Trilha {
  id: number;
  tipo: "video" | "audio";
  timescale: number;
  duracaoMidia: number;
  duracaoFragmentos: number;
  /** Bytes do prefixo de comprimento das unidades NAL (H.264); 0 = não confere NAL (áudio). */
  tamanhoPrefixoNal: number;
  largura: number;
  altura: number;
  amostras: Amostra[];
  padraoDuracao: number;
  padraoTamanho: number;
}

/**
 * Caixas de topo aceitas. Qualquer outra é recusada como dado não reconhecido. `free`/`skip`/`wide` (espaço livre),
 * `uuid` (extensões de fabricante) e `meta`/`udta` têm conteúdo opaco: são aceitas por serem parte do formato, mas
 * o conteúdo não é interpretado (limitação documentada).
 */
const CAIXAS_DE_TOPO = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "moof", "mfra", "sidx", "styp", "uuid", "meta", "pdin", "prft"]);

class LeitorMp4 {
  private caixasLidas = 0;

  constructor(
    readonly bytes: Bytes,
    private readonly limites: Limites,
  ) {}

  caixas(inicio: number, fim: number): Caixa[] {
    const saida: Caixa[] = [];
    let p = inicio;
    while (p < fim) {
      this.caixasLidas += 1;
      if (this.caixasLidas > this.limites.maxCaixasMp4) throw recusa("estrutura", "MP4: caixas demais");
      if (p + 8 > fim) throw recusa("estrutura", `MP4: caixa truncada no offset ${p}`);
      let tamanho = this.bytes.u32be(p, "MP4: caixa");
      const tipo = this.bytes.ascii(p + 4, 4, "MP4: caixa");
      let cabecalho = 8;
      if (tamanho === 1) {
        if (p + 16 > fim) throw recusa("estrutura", "MP4: largesize truncado");
        tamanho = this.bytes.u64be(p + 8, "MP4: largesize");
        cabecalho = 16;
      } else if (tamanho === 0) {
        tamanho = fim - p;
      }
      if (tamanho < cabecalho || p + tamanho > fim) throw recusa("estrutura", `MP4: caixa ${JSON.stringify(tipo)} com tamanho ${tamanho} inconsistente (offset ${p})`);
      saida.push({ tipo, inicio: p, dados: p + cabecalho, fim: p + tamanho });
      p += tamanho;
    }
    return saida;
  }

  filhas(caixa: Caixa, deslocamento = 0): Caixa[] {
    return this.caixas(caixa.dados + deslocamento, caixa.fim);
  }
}

function achar(lista: readonly Caixa[], tipo: string): Caixa | undefined {
  return lista.find((caixa) => caixa.tipo === tipo);
}

function exigir(lista: readonly Caixa[], tipo: string, contexto: string): Caixa {
  const caixa = achar(lista, tipo);
  if (!caixa) throw recusa("estrutura", `MP4: ${contexto} sem ${tipo}`);
  return caixa;
}

/** Tamanho de um descritor MPEG-4 (até 4 bytes de 7 bits). Devolve [tamanho, posição dos dados]. */
function tamanhoDescritor(bytes: Bytes, p: number): [number, number] {
  let tamanho = 0;
  for (let i = 0; i < 4; i += 1) {
    const byte = bytes.u8(p + i, "MP4: descritor do esds");
    tamanho = (tamanho << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return [tamanho, p + i + 1];
  }
  throw recusa("estrutura", "MP4: tamanho de descritor inválido");
}

/** `objectTypeIndication` do DecoderConfigDescriptor dentro de um `esds`. */
function objectTypeIndication(bytes: Bytes, esds: Caixa): number {
  let p = esds.dados + 4;
  if (bytes.u8(p, "MP4: esds") !== 0x03) throw recusa("estrutura", "MP4: esds sem ES_Descriptor");
  [, p] = tamanhoDescritor(bytes, p + 1);
  const flags = bytes.u8(p + 2, "MP4: esds");
  p += 3;
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + bytes.u8(p, "MP4: esds");
  if (flags & 0x20) p += 2;
  if (bytes.u8(p, "MP4: esds") !== 0x04) throw recusa("estrutura", "MP4: esds sem DecoderConfigDescriptor");
  [, p] = tamanhoDescritor(bytes, p + 1);
  if (p >= esds.fim) throw recusa("estrutura", "MP4: esds truncado");
  return bytes.u8(p, "MP4: esds");
}

function lerTrilha(leitor: LeitorMp4, trak: Caixa, limites: Limites): Trilha {
  const { bytes } = leitor;
  const filhasTrak = leitor.filhas(trak);
  const tkhd = exigir(filhasTrak, "tkhd", "trak");
  const mdiaFilhas = leitor.filhas(exigir(filhasTrak, "mdia", "trak"));
  const hdlr = exigir(mdiaFilhas, "hdlr", "mdia");
  const mdhd = exigir(mdiaFilhas, "mdhd", "mdia");
  const manipulador = bytes.ascii(hdlr.dados + 8, 4, "MP4: hdlr");
  if (manipulador !== "vide" && manipulador !== "soun") throw recusa("codec", `MP4: trilha do tipo ${JSON.stringify(manipulador)} não permitida`);

  const id = bytes.u32be(tkhd.dados + (bytes.u8(tkhd.dados) === 1 ? 20 : 12), "MP4: tkhd");
  const versaoMdhd = bytes.u8(mdhd.dados);
  const timescale = bytes.u32be(mdhd.dados + (versaoMdhd === 1 ? 20 : 12), "MP4: mdhd");
  const duracaoMidia = versaoMdhd === 1 ? bytes.u64be(mdhd.dados + 24, "MP4: mdhd") : bytes.u32be(mdhd.dados + 16, "MP4: mdhd");
  if (!timescale) throw recusa("estrutura", "MP4: timescale zero");

  const stbl = leitor.filhas(exigir(leitor.filhas(exigir(mdiaFilhas, "minf", "mdia")), "stbl", "minf"));
  const stsd = exigir(stbl, "stsd", "stbl");
  if (bytes.u32be(stsd.dados + 4, "MP4: stsd") !== 1) throw recusa("estrutura", "MP4: stsd deve ter exatamente uma entrada");
  const entrada = leitor.caixas(stsd.dados + 8, stsd.fim)[0];
  if (!entrada) throw recusa("estrutura", "MP4: stsd vazio");

  const trilha: Trilha = {
    id,
    tipo: manipulador === "vide" ? "video" : "audio",
    timescale,
    duracaoMidia,
    duracaoFragmentos: 0,
    tamanhoPrefixoNal: 0,
    largura: 0,
    altura: 0,
    amostras: [],
    padraoDuracao: 0,
    padraoTamanho: 0,
  };

  if (trilha.tipo === "video") {
    if (!CODECS_VIDEO_PERMITIDOS.includes(entrada.tipo)) throw recusa("codec", `MP4: codec de vídeo ${JSON.stringify(entrada.tipo)} não permitido`);
    trilha.largura = bytes.u16be(entrada.dados + 24, "MP4: entrada de vídeo");
    trilha.altura = bytes.u16be(entrada.dados + 26, "MP4: entrada de vídeo");
    exigirDimensoes("MP4", trilha.largura, trilha.altura, limites);
    const avcC = exigir(leitor.filhas(entrada, 78), "avcC", "entrada avc1");
    trilha.tamanhoPrefixoNal = (bytes.u8(avcC.dados + 4, "MP4: avcC") & 0x03) + 1;
    if (trilha.tamanhoPrefixoNal === 3) throw recusa("estrutura", "MP4: avcC com prefixo de NAL inválido");
  } else {
    if (!CODECS_AUDIO_PERMITIDOS.includes(entrada.tipo)) throw recusa("codec", `MP4: codec de áudio ${JSON.stringify(entrada.tipo)} não permitido`);
    const versaoSom = bytes.u16be(entrada.dados + 8, "MP4: entrada de áudio");
    const deslocamento = versaoSom === 1 ? 44 : versaoSom === 2 ? 64 : 28;
    const filhasEntrada = leitor.filhas(entrada, deslocamento);
    const wave = achar(filhasEntrada, "wave");
    const esds = achar(filhasEntrada, "esds") ?? (wave ? achar(leitor.filhas(wave), "esds") : undefined);
    if (!esds) throw recusa("codec", "MP4: mp4a sem esds");
    const oti = objectTypeIndication(bytes, esds);
    if (!OTI_AAC.includes(oti)) throw recusa("codec", `MP4: áudio mp4a não AAC (objectTypeIndication 0x${oti.toString(16)})`);
  }

  // Tabelas de amostras do moov (MP4 progressivo; no fragmentado elas vêm vazias).
  const stsz = exigir(stbl, "stsz", "stbl");
  const stco = achar(stbl, "stco") ?? achar(stbl, "co64");
  const stsc = exigir(stbl, "stsc", "stbl");
  if (!stco) throw recusa("estrutura", "MP4: stbl sem stco/co64");
  const tamanhoFixo = bytes.u32be(stsz.dados + 4, "MP4: stsz");
  const totalAmostras = bytes.u32be(stsz.dados + 8, "MP4: stsz");
  if (totalAmostras > limites.maxAmostrasMp4) throw recusa("estrutura", "MP4: amostras demais");
  if (!tamanhoFixo && stsz.dados + 12 + 4 * totalAmostras > stsz.fim) throw recusa("estrutura", "MP4: stsz inconsistente");
  const co64 = stco.tipo === "co64";
  const totalChunks = bytes.u32be(stco.dados + 4, "MP4: stco");
  if (stco.dados + 8 + totalChunks * (co64 ? 8 : 4) > stco.fim) throw recusa("estrutura", "MP4: stco inconsistente");
  const entradasStsc = bytes.u32be(stsc.dados + 4, "MP4: stsc");
  if (stsc.dados + 8 + entradasStsc * 12 > stsc.fim) throw recusa("estrutura", "MP4: stsc inconsistente");

  let amostra = 0;
  for (let e = 0; e < entradasStsc && amostra < totalAmostras; e += 1) {
    const primeiroChunk = bytes.u32be(stsc.dados + 8 + e * 12);
    const porChunk = bytes.u32be(stsc.dados + 12 + e * 12);
    const ultimoChunk = e + 1 < entradasStsc ? bytes.u32be(stsc.dados + 8 + (e + 1) * 12) - 1 : totalChunks;
    if (primeiroChunk < 1 || ultimoChunk > totalChunks || ultimoChunk < primeiroChunk || porChunk === 0) throw recusa("estrutura", "MP4: stsc aponta para chunk inexistente");
    for (let chunk = primeiroChunk; chunk <= ultimoChunk && amostra < totalAmostras; chunk += 1) {
      let offset = co64 ? bytes.u64be(stco.dados + 8 + (chunk - 1) * 8) : bytes.u32be(stco.dados + 8 + (chunk - 1) * 4);
      for (let s = 0; s < porChunk && amostra < totalAmostras; s += 1, amostra += 1) {
        const tamanho = tamanhoFixo || bytes.u32be(stsz.dados + 12 + amostra * 4);
        trilha.amostras.push({ offset, tamanho });
        offset += tamanho;
      }
    }
  }
  if (amostra !== totalAmostras) throw recusa("estrutura", "MP4: stsc não cobre todas as amostras");
  return trilha;
}

/** Lê os fragmentos (`moof/traf/tfhd/trun`) e acrescenta as amostras e durações às trilhas. */
function lerFragmentos(leitor: LeitorMp4, moofs: readonly Caixa[], trilhas: ReadonlyMap<number, Trilha>, limites: Limites): void {
  const { bytes } = leitor;
  for (const moof of moofs) {
    let fimDadosAnterior = moof.inicio;
    for (const traf of leitor.filhas(moof).filter((caixa) => caixa.tipo === "traf")) {
      const filhasTraf = leitor.filhas(traf);
      const tfhd = exigir(filhasTraf, "tfhd", "traf");
      const flagsTfhd = bytes.u32be(tfhd.dados, "MP4: tfhd") & 0xffffff;
      const trilha = trilhas.get(bytes.u32be(tfhd.dados + 4, "MP4: tfhd"));
      if (!trilha) throw recusa("estrutura", "MP4: fragmento de trilha inexistente");
      let q = tfhd.dados + 8;
      let base = flagsTfhd & 0x020000 ? moof.inicio : fimDadosAnterior;
      if (flagsTfhd & 0x01) {
        base = bytes.u64be(q, "MP4: tfhd");
        q += 8;
      }
      if (flagsTfhd & 0x02) q += 4;
      let padraoDuracao = trilha.padraoDuracao;
      let padraoTamanho = trilha.padraoTamanho;
      if (flagsTfhd & 0x08) {
        padraoDuracao = bytes.u32be(q, "MP4: tfhd");
        q += 4;
      }
      if (flagsTfhd & 0x10) padraoTamanho = bytes.u32be(q, "MP4: tfhd");

      let proximoOffset = base;
      for (const trun of filhasTraf.filter((caixa) => caixa.tipo === "trun")) {
        const flags = bytes.u32be(trun.dados, "MP4: trun") & 0xffffff;
        const quantidade = bytes.u32be(trun.dados + 4, "MP4: trun");
        let r = trun.dados + 8;
        if (flags & 0x01) {
          proximoOffset = base + bytes.i32be(r, "MP4: trun");
          r += 4;
        }
        if (flags & 0x04) r += 4;
        const porAmostra = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
        if (trilha.amostras.length + quantidade > limites.maxAmostrasMp4) throw recusa("estrutura", "MP4: amostras demais");
        if (r + quantidade * porAmostra > trun.fim) throw recusa("estrutura", "MP4: trun inconsistente");
        for (let i = 0; i < quantidade; i += 1) {
          let duracao = padraoDuracao;
          let tamanho = padraoTamanho;
          if (flags & 0x100) {
            duracao = bytes.u32be(r);
            r += 4;
          }
          if (flags & 0x200) {
            tamanho = bytes.u32be(r);
            r += 4;
          }
          if (flags & 0x400) r += 4;
          if (flags & 0x800) r += 4;
          trilha.amostras.push({ offset: proximoOffset, tamanho });
          trilha.duracaoFragmentos += duracao;
          proximoOffset += tamanho;
        }
      }
      fimDadosAnterior = proximoOffset;
    }
  }
}

/** Cada amostra de vídeo H.264 precisa ser EXATAMENTE ladrilhada por unidades NAL com prefixo de comprimento coerente. */
function conferirUnidadesNal(bytes: Bytes, trilha: Trilha): void {
  for (const [indice, amostra] of trilha.amostras.entries()) {
    let q = amostra.offset;
    const fim = amostra.offset + amostra.tamanho;
    while (q < fim) {
      if (q + trilha.tamanhoPrefixoNal > fim) throw recusa("estrutura", `MP4: amostra ${indice} com NAL truncada`);
      let tamanhoNal = 0;
      for (let k = 0; k < trilha.tamanhoPrefixoNal; k += 1) tamanhoNal = tamanhoNal * 256 + bytes.u8(q + k);
      q += trilha.tamanhoPrefixoNal;
      if (tamanhoNal === 0 || q + tamanhoNal > fim) throw recusa("estrutura", `MP4: amostra ${indice} com tamanho de NAL inconsistente`);
      if (bytes.u8(q) & 0x80) throw recusa("estrutura", `MP4: amostra ${indice} com NAL inválida (forbidden_zero_bit)`);
      q += tamanhoNal;
    }
  }
}

/**
 * Fase 60.4.3.4.1 — estrutura do MP4 (ISO-BMFF), progressivo E fragmentado:
 * - as caixas de topo cobrem o arquivo EXATAMENTE e só têm tipos reconhecidos; `ftyp` primeiro; um único `moov`; ao menos um `mdat`;
 * - exatamente UMA trilha de vídeo H.264 (`avc1`/`avc3` com `avcC`) e no máximo UMA de áudio AAC; outras trilhas são recusadas;
 * - toda amostra (do `stbl` ou dos `moof/trun`) fica inteira dentro de um `mdat`; as de vídeo são ladrilhadas por NAL coerentes;
 * - dimensões dentro dos limites; duração > 0 e ≤ `maxDuracaoVideoSegundos`.
 * Não decodifica o bitstream H.264 (limitação documentada: sem FFmpeg nesta fase).
 */
export function validarEstruturaMp4(b: Uint8Array, limites: Limites = LIMITES_VALIDACAO_MIDIA): { largura: number; altura: number; duracaoSegundos: number } {
  const bytes = new Bytes(b);
  if (bytes.tamanho < 8 || bytes.ascii(4, 4) !== "ftyp") throw recusa("formato", "MP4: não começa com ftyp");
  const leitor = new LeitorMp4(bytes, limites);
  const topo = leitor.caixas(0, bytes.tamanho);
  const desconhecida = topo.find((caixa) => !CAIXAS_DE_TOPO.has(caixa.tipo));
  if (desconhecida) throw recusa("dados-extras", `MP4: caixa de topo não reconhecida ${JSON.stringify(desconhecida.tipo)}`);
  const moovs = topo.filter((caixa) => caixa.tipo === "moov");
  if (moovs.length !== 1) throw recusa("estrutura", `MP4: ${moovs.length} caixas moov`);
  const mdats = topo.filter((caixa) => caixa.tipo === "mdat");
  if (!mdats.length) throw recusa("estrutura", "MP4: sem mdat");

  const moov = leitor.filhas(moovs[0]!);
  const trilhas = new Map<number, Trilha>();
  for (const trak of moov.filter((caixa) => caixa.tipo === "trak")) {
    const trilha = lerTrilha(leitor, trak, limites);
    if (trilhas.has(trilha.id)) throw recusa("estrutura", "MP4: track_ID repetido");
    trilhas.set(trilha.id, trilha);
  }
  const videos = [...trilhas.values()].filter((trilha) => trilha.tipo === "video");
  const audios = [...trilhas.values()].filter((trilha) => trilha.tipo === "audio");
  if (videos.length !== 1) throw recusa(videos.length ? "codec" : "estrutura", `MP4: ${videos.length} trilhas de vídeo (exigida exatamente 1)`);
  if (audios.length > 1) throw recusa("codec", "MP4: mais de uma trilha de áudio");

  const moofs = topo.filter((caixa) => caixa.tipo === "moof");
  const mvex = achar(moov, "mvex");
  if (moofs.length && !mvex) throw recusa("estrutura", "MP4: fragmentos sem mvex");
  if (mvex) {
    for (const trex of leitor.filhas(mvex).filter((caixa) => caixa.tipo === "trex")) {
      const trilha = trilhas.get(bytes.u32be(trex.dados + 4, "MP4: trex"));
      if (!trilha) continue;
      trilha.padraoDuracao = bytes.u32be(trex.dados + 12, "MP4: trex");
      trilha.padraoTamanho = bytes.u32be(trex.dados + 16, "MP4: trex");
    }
  }
  lerFragmentos(leitor, moofs, trilhas, limites);

  const dentroDeMdat = (amostra: Amostra) => mdats.some((mdat) => amostra.offset >= mdat.dados && amostra.offset + amostra.tamanho <= mdat.fim);
  let duracaoSegundos = 0;
  for (const trilha of trilhas.values()) {
    for (const [indice, amostra] of trilha.amostras.entries()) {
      if (amostra.tamanho === 0 || !dentroDeMdat(amostra)) throw recusa("estrutura", `MP4: amostra ${indice} fora do mdat (truncado ou tabela inconsistente)`);
    }
    // Fragmentado: o `mdhd` costuma trazer 0 (ou, em alguns muxers, o total) — usa o maior dos dois, sem somar duas vezes.
    const duracaoTrilha = trilha.duracaoFragmentos > 0 ? Math.max(trilha.duracaoMidia, trilha.duracaoFragmentos) : trilha.duracaoMidia;
    duracaoSegundos = Math.max(duracaoSegundos, duracaoTrilha / trilha.timescale);
  }
  const video = videos[0]!;
  if (!video.amostras.length) throw recusa("estrutura", "MP4: trilha de vídeo sem amostras");
  conferirUnidadesNal(bytes, video);
  if (!(duracaoSegundos > 0)) throw recusa("estrutura", "MP4: duração zero");
  if (duracaoSegundos > limites.maxDuracaoVideoSegundos) throw recusa("duracao", `MP4: duração ${duracaoSegundos.toFixed(2)} s acima do limite`);
  return { largura: video.largura, altura: video.altura, duracaoSegundos };
}
