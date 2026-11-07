import { beforeAll, describe, expect, it } from "bun:test";
import { deflateSync } from "node:zlib";
import { arquivoDoFormato, chunkPng, fixtureDeMidia, FIXTURES_MIDIA } from "../../../test-utils/media-storage-falso.util.js";
import { caixaMp4, mp4Sintetico } from "../../../test-utils/mp4-sintetico.util.js";
import { LIMITES_VALIDACAO_MIDIA } from "./validacao-midia.constants.js";
import type { MotivoRecusa, ResultadoValidacao } from "./validacao-midia.types.js";
import { validarConteudoDeMidia } from "./validar-midia.js";

/**
 * Fase 60.4.3.4.1 — validação de conteúdo (camada A: estrutura; camada B: `Bun.Image`), chamada DIRETAMENTE (sem o
 * subprocesso, coberto em `validador-midia.service.spec.ts`). Reproduz os 37 casos do protótipo da auditoria
 * 60.4.3.4 (`auditorias/60.4.3.4-anexos/matriz-camadas.md`) e acrescenta os casos das decisões desta fase.
 *
 * Diferenças intencionais em relação ao protótipo: imagens "grandes" geradas em 2000×1500 (não 4000×3000) para manter
 * a suíte rápida; o limite de pixels agora é 25 MP (era 40 MP), então a "bomba real" de 36 MP passa a ser recusada.
 */

const ascii = (texto: string) => new Uint8Array([...texto].map((c) => c.charCodeAt(0)));
const juntar = (...partes: Uint8Array[]) => new Uint8Array(Buffer.concat(partes));
const be32 = (v: number) => {
  const saida = new Uint8Array(4);
  new DataView(saida.buffer).setUint32(0, v);
  return saida;
};
const le32 = (v: number) => {
  const saida = new Uint8Array(4);
  new DataView(saida.buffer).setUint32(0, v, true);
  return saida;
};
const ASSINATURA_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function ihdr(largura: number, altura: number): Uint8Array {
  const dados = new Uint8Array(13);
  const vista = new DataView(dados.buffer);
  vista.setUint32(0, largura);
  vista.setUint32(4, altura);
  dados[8] = 8;
  dados[9] = 2;
  return chunkPng("IHDR", dados);
}
const IEND = () => chunkPng("IEND", new Uint8Array(0));
/** PNG RGB com gradiente e ruído leve ("foto" sintética). */
function pngSintetico(largura: number, altura: number): Uint8Array {
  const linha = 1 + largura * 3;
  const bruto = new Uint8Array(linha * altura);
  let s = 99;
  for (let y = 0; y < altura; y += 1) {
    for (let x = 0; x < largura; x += 1) {
      s = (s * 1103515245 + 12345) >>> 0;
      const r = (s >>> 24) % 24;
      const o = y * linha + 1 + x * 3;
      bruto[o] = ((x * 255) / largura + r) & 255;
      bruto[o + 1] = ((y * 255) / altura + r) & 255;
      bruto[o + 2] = r;
    }
  }
  return juntar(ASSINATURA_PNG, ihdr(largura, altura), chunkPng("IDAT", deflateSync(bruto)), IEND());
}
/** PNG cujo IDAT é só zeros comprimidos (alta taxa de expansão). */
function pngDeZeros(largura: number, altura: number): Uint8Array {
  return juntar(ASSINATURA_PNG, ihdr(largura, altura), chunkPng("IDAT", deflateSync(new Uint8Array((1 + largura * 3) * altura), { level: 9 })), IEND());
}
/** GIF 1×1 com `n` quadros. */
function gifComQuadros(n: number): Uint8Array {
  const cabecalho = juntar(ascii("GIF89a"), new Uint8Array([1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]));
  const quadro = new Uint8Array([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]);
  return juntar(cabecalho, ...Array.from({ length: n }, () => quadro), new Uint8Array([0x3b]));
}
/** Insere um segmento APP2 "MPF\0" logo depois do SOI (índice Multi-Picture Format mínimo). */
function comIndiceMpf(jpeg: Uint8Array): Uint8Array {
  const dados = juntar(ascii("MPF\0"), new Uint8Array(8));
  return juntar(jpeg.subarray(0, 2), new Uint8Array([0xff, 0xe2, 0, dados.length + 2]), dados, jpeg.subarray(2));
}
/** WebP VP8X com a flag de animação, ANIM e um ANMF com o quadro do fixture. */
function webpAnimado(comFlag: boolean): Uint8Array {
  const base = fixtureDeMidia(FIXTURES_MIDIA.webp);
  const chunkImagem = base.subarray(12);
  const vp8x = new Uint8Array(10);
  vp8x[0] = comFlag ? 0x02 : 0x00;
  vp8x.set(le32(7).subarray(0, 3), 4);
  vp8x.set(le32(7).subarray(0, 3), 7);
  const anmf = juntar(new Uint8Array(16), chunkImagem);
  const corpo = juntar(ascii("WEBP"), ascii("VP8X"), le32(10), vp8x, ...(comFlag ? [ascii("ANIM"), le32(6), new Uint8Array(6)] : []), ascii("ANMF"), le32(anmf.length), anmf);
  return juntar(ascii("RIFF"), le32(corpo.length), corpo);
}

async function motivo(contentType: string, bytes: Uint8Array): Promise<MotivoRecusa | "aceito"> {
  const resultado: ResultadoValidacao = await validarConteudoDeMidia(contentType, bytes);
  return resultado.valido ? "aceito" : resultado.motivo;
}

describe("validação de conteúdo de mídia (Fase 60.4.3.4.1)", () => {
  let jpegGrande: Uint8Array;
  let jpegProgressivo: Uint8Array;
  let webpGrande: Uint8Array;
  let pngMedio: Uint8Array;

  beforeAll(async () => {
    const foto = pngSintetico(2000, 1500);
    jpegGrande = await new Bun.Image(foto.slice()).jpeg({ quality: 92 }).bytes();
    jpegProgressivo = await new Bun.Image(foto.slice()).jpeg({ quality: 85, progressive: true }).bytes();
    webpGrande = await new Bun.Image(foto.slice()).webp({ quality: 90 }).bytes();
    pngMedio = pngSintetico(800, 600);
  });

  describe("casos do protótipo 60.4.3.4 (37) — válidos", () => {
    it("V1–V4: JPEG, PNG, GIF e WebP reais mínimos são aceitos", async () => {
      for (const formato of ["image/jpeg", "image/png", "image/gif", "image/webp"]) expect(await motivo(formato, arquivoDoFormato(formato, 1024))).toBe("aceito");
    });
    it("V5: JPEG de EXATAMENTE 5 MiB (segmentos COM) é aceito", async () => {
      expect(await motivo("image/jpeg", arquivoDoFormato("image/jpeg", 5 * 1024 * 1024))).toBe("aceito");
    });
    it("V6/V6b/V7/V8: JPEG baseline e progressivo, WebP e PNG de fotos sintéticas são aceitos com as dimensões reais", async () => {
      expect(await validarConteudoDeMidia("image/jpeg", jpegGrande)).toEqual({ valido: true, formato: "jpeg", largura: 2000, altura: 1500 });
      expect(await motivo("image/jpeg", jpegProgressivo)).toBe("aceito");
      expect(await validarConteudoDeMidia("image/webp", webpGrande)).toEqual({ valido: true, formato: "webp", largura: 2000, altura: 1500 });
      expect(await validarConteudoDeMidia("image/png", pngMedio)).toEqual({ valido: true, formato: "png", largura: 800, altura: 600 });
    });
    it("V9: GIF com 100 quadros (o limite) é aceito", async () => {
      expect(await validarConteudoDeMidia("image/gif", gifComQuadros(100))).toEqual({ valido: true, formato: "gif", largura: 1, altura: 1, quadros: 100 });
    });
    it("V10–V12: MP4 fragmentado (bateria), MP4 de EXATAMENTE 15 MiB e MP4 progressivo são aceitos", async () => {
      const fragmentado = await validarConteudoDeMidia("video/mp4", fixtureDeMidia(FIXTURES_MIDIA.mp4Fragmentado));
      expect(fragmentado).toMatchObject({ valido: true, formato: "mp4", largura: 64, altura: 64 });
      expect(await motivo("video/mp4", arquivoDoFormato("video/mp4", 15 * 1024 * 1024))).toBe("aceito");
      expect(await motivo("video/mp4", fixtureDeMidia(FIXTURES_MIDIA.mp4Progressivo))).toBe("aceito");
    });
  });

  describe("casos do protótipo 60.4.3.4 (37) — inválidos e hostis", () => {
    it("N8: o JPEG corrompido da bateria 60.4.3.3.2 (324 bytes, assinatura válida) é RECUSADO", async () => {
      const resultado = await validarConteudoDeMidia("image/jpeg", fixtureDeMidia(FIXTURES_MIDIA.n8));
      expect(resultado.valido).toBe(false);
      expect(resultado).toMatchObject({ motivo: "estrutura" });
    });
    it("I1: arquivo vazio", async () => {
      expect(await motivo("image/jpeg", new Uint8Array(0))).toBe("estrutura");
    });
    it("I2/I3/I5: JPEG truncado, sem EOI e com 4 KiB de lixo após o EOI", async () => {
      expect(await motivo("image/jpeg", jpegGrande.slice(0, jpegGrande.length >> 1))).toBe("estrutura");
      expect(await motivo("image/jpeg", jpegGrande.slice(0, -2))).toBe("estrutura");
      expect(await motivo("image/jpeg", juntar(arquivoDoFormato("image/jpeg", 1024), new Uint8Array(4096).fill(0x41)))).toBe("dados-extras");
    });
    it("I6/I7/I8: PNG com CRC inválido, truncado e sem IEND", async () => {
      const crcErrado = pngMedio.slice();
      crcErrado[crcErrado.length - 20] = crcErrado[crcErrado.length - 20]! ^ 0x55;
      expect(await motivo("image/png", crcErrado)).toBe("estrutura");
      expect(await motivo("image/png", pngMedio.slice(0, pngMedio.length >> 1))).toBe("estrutura");
      expect(await motivo("image/png", pngMedio.slice(0, -12))).toBe("estrutura");
    });
    it("I9/I10: WebP truncado e com tamanho RIFF inconsistente", async () => {
      expect(await motivo("image/webp", webpGrande.slice(0, webpGrande.length >> 1))).toBe("estrutura");
      const riffInflado = webpGrande.slice();
      new DataView(riffInflado.buffer).setUint32(4, riffInflado.length * 4, true);
      expect(await motivo("image/webp", riffInflado)).toBe("estrutura");
    });
    it("I11/I12: GIF sem trailer e truncado", async () => {
      const gif = arquivoDoFormato("image/gif", 1024);
      expect(await motivo("image/gif", gif.slice(0, -1))).toBe("estrutura");
      expect(await motivo("image/gif", gif.slice(0, gif.length >> 1))).toBe("estrutura");
    });
    it("I13/I14/M7: conteúdo de outro formato (PNG como JPEG, PDF como PNG, JPEG como MP4)", async () => {
      expect(await motivo("image/jpeg", arquivoDoFormato("image/png", 1024))).toBe("estrutura");
      expect(await motivo("image/png", ascii("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF"))).toBe("formato");
      expect(await motivo("video/mp4", arquivoDoFormato("image/jpeg", 1024))).toBe("formato");
    });
    it("M1–M6: MP4 só com ftyp, truncado, caixa inconsistente, sem trilha de vídeo, mdat de lixo, progressivo truncado", async () => {
      const fragmentado = fixtureDeMidia(FIXTURES_MIDIA.mp4Fragmentado);
      const progressivo = fixtureDeMidia(FIXTURES_MIDIA.mp4Progressivo);
      expect(await motivo("video/mp4", fragmentado.slice(0, 36))).toBe("estrutura");
      expect(await motivo("video/mp4", fragmentado.slice(0, Math.floor(fragmentado.length * 0.6)))).toBe("estrutura");
      const moovInflado = fragmentado.slice();
      const vista = new DataView(moovInflado.buffer);
      vista.setUint32(36, vista.getUint32(36) + 100);
      expect(await motivo("video/mp4", moovInflado)).not.toBe("aceito");
      const semVideo = fragmentado.slice();
      semVideo.set(ascii("soun"), Buffer.from(semVideo).indexOf("vide"));
      expect(await motivo("video/mp4", semVideo)).not.toBe("aceito");
      const lixo = progressivo.slice();
      const inicioMdat = Buffer.from(lixo).lastIndexOf("mdat") + 4;
      let s = 7;
      for (let i = inicioMdat; i < lixo.length; i += 1) {
        s = (s * 1103515245 + 12345) >>> 0;
        lixo[i] = s >>> 24;
      }
      expect(await motivo("video/mp4", lixo)).toBe("estrutura");
      expect(await motivo("video/mp4", progressivo.slice(0, -100))).toBe("estrutura");
    });
    it("S1/S2: cabeçalhos com dimensões gigantes (PNG 30000², JPEG SOF 60000²) — recusa antes de alocar", async () => {
      const bomba = juntar(ASSINATURA_PNG, ihdr(30000, 30000), chunkPng("IDAT", deflateSync(new Uint8Array(1000))), IEND());
      expect(await motivo("image/png", bomba)).toBe("dimensoes");
      const jpeg = arquivoDoFormato("image/jpeg", 1024).slice();
      const sof = Buffer.from(jpeg).indexOf(Buffer.from([0xff, 0xc0]));
      new DataView(jpeg.buffer).setUint16(sof + 5, 60000);
      new DataView(jpeg.buffer).setUint16(sof + 7, 60000);
      expect(await motivo("image/jpeg", jpeg)).toBe("dimensoes");
    });
    it("S3: PNG de zeros de 6000×6000 (36 MP) passa a ser recusado pelo limite de 25 MP", async () => {
      expect(await motivo("image/png", pngDeZeros(6000, 6000))).toBe("dimensoes");
    });
    it("S4: GIF com 5000 quadros", async () => {
      expect(await motivo("image/gif", gifComQuadros(5000))).toBe("quadros");
    });
  });

  describe("decisões da Fase 60.4.3.4.1", () => {
    it("limite de 25 MP: 5000×5000 (25 MP exatos, alta expansão) é aceito; 5000×5001 é recusado", async () => {
      expect(await motivo("image/png", pngDeZeros(5000, 5000))).toBe("aceito");
      expect(await motivo("image/png", pngDeZeros(5000, 5001))).toBe("dimensoes");
    });
    it("GIF: 101 quadros é recusado", async () => {
      expect(await motivo("image/gif", gifComQuadros(LIMITES_VALIDACAO_MIDIA.maxQuadrosGif + 1))).toBe("quadros");
    });
    it("APNG (acTL) é recusado como animação", async () => {
      const png = fixtureDeMidia(FIXTURES_MIDIA.png);
      const apng = juntar(png.subarray(0, 33), chunkPng("acTL", juntar(be32(1), be32(0))), png.subarray(33));
      expect(await motivo("image/png", apng)).toBe("animacao");
    });
    it("WebP animado é recusado (flag do VP8X, ou ANMF mesmo sem a flag)", async () => {
      expect(await motivo("image/webp", webpAnimado(true))).toBe("animacao");
      expect(await motivo("image/webp", webpAnimado(false))).toBe("animacao");
    });
    it("WebP estendido (VP8X + XMP) estático é aceito; chunk desconhecido é recusado", async () => {
      expect(await motivo("image/webp", arquivoDoFormato("image/webp", 2048))).toBe("aceito");
      const base = fixtureDeMidia(FIXTURES_MIDIA.webp);
      const corpo = juntar(base.subarray(8), ascii("ZZZZ"), le32(4), new Uint8Array(4));
      expect(await motivo("image/webp", juntar(ascii("RIFF"), le32(corpo.length), corpo))).toBe("estrutura");
    });
    it("MP4: vídeo H.264 com áudio AAC é aceito", async () => {
      expect(await motivo("video/mp4", mp4Sintetico({ trilhaExtra: { manipulador: "soun", codec: "mp4a", oti: 0x40 } }))).toBe("aceito");
    });
    it("MP4: codecs não permitidos — vídeo HEVC/AV1, áudio mp4a não AAC (MP3), áudio AC-3, trilha de texto", async () => {
      expect(await motivo("video/mp4", mp4Sintetico({ codecVideo: "hvc1" }))).toBe("codec");
      expect(await motivo("video/mp4", mp4Sintetico({ codecVideo: "av01" }))).toBe("codec");
      expect(await motivo("video/mp4", mp4Sintetico({ trilhaExtra: { manipulador: "soun", codec: "mp4a", oti: 0x6b } }))).toBe("codec");
      expect(await motivo("video/mp4", mp4Sintetico({ trilhaExtra: { manipulador: "soun", codec: "ac-3" } }))).toBe("codec");
      expect(await motivo("video/mp4", mp4Sintetico({ trilhaExtra: { manipulador: "text", codec: "tx3g" } }))).toBe("codec");
    });
    it("MP4: duração de 30 s é aceita; 30,5 s é recusada", async () => {
      expect(await motivo("video/mp4", mp4Sintetico({ duracaoVideoSegundos: 30 }))).toBe("aceito");
      expect(await motivo("video/mp4", mp4Sintetico({ duracaoVideoSegundos: 30.5 }))).toBe("duracao");
    });
    it("MP4: caixa de topo desconhecida é recusada; free/skip são aceitas", async () => {
      const base = fixtureDeMidia(FIXTURES_MIDIA.mp4Progressivo);
      expect(await motivo("video/mp4", juntar(base, caixaMp4("zzzz", new Uint8Array(16))))).toBe("dados-extras");
      expect(await motivo("video/mp4", juntar(base, caixaMp4("skip", new Uint8Array(16))))).toBe("aceito");
    });
    it("bytes adicionais no JPEG: imagem anexa com índice MPF (Ultra HDR) é aceita; lixo, JPEG sem MPF ou anexo truncado não", async () => {
      const jpeg = fixtureDeMidia(FIXTURES_MIDIA.jpeg);
      const comMpf = comIndiceMpf(jpeg);
      expect(await motivo("image/jpeg", juntar(comMpf, jpeg))).toBe("aceito");
      expect(await motivo("image/jpeg", juntar(comMpf, jpeg, jpeg))).toBe("aceito");
      expect(await motivo("image/jpeg", juntar(comMpf, ascii("PK\u0003\u0004 zip anexado")))).toBe("dados-extras");
      expect(await motivo("image/jpeg", juntar(jpeg, jpeg))).toBe("dados-extras");
      expect(await motivo("image/jpeg", juntar(comMpf, jpeg.slice(0, 300)))).toBe("estrutura");
      const muitas = juntar(comMpf, ...Array.from({ length: LIMITES_VALIDACAO_MIDIA.maxImagensAnexasJpeg + 1 }, () => jpeg));
      expect(await motivo("image/jpeg", muitas)).toBe("dados-extras");
    });
    it("bytes adicionais em PNG, GIF e WebP são sempre recusados", async () => {
      const extra = new Uint8Array(16).fill(0x41);
      expect(await motivo("image/png", juntar(fixtureDeMidia(FIXTURES_MIDIA.png), extra))).toBe("dados-extras");
      expect(await motivo("image/gif", juntar(fixtureDeMidia(FIXTURES_MIDIA.gif), extra))).toBe("dados-extras");
      expect(await motivo("image/webp", juntar(fixtureDeMidia(FIXTURES_MIDIA.webp), extra))).toBe("dados-extras");
    });
    it("JPEG aritmético/hierárquico (SOF fora de 0/1/2) é recusado", async () => {
      const jpeg = arquivoDoFormato("image/jpeg", 1024).slice();
      jpeg[Buffer.from(jpeg).indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc9;
      expect(await motivo("image/jpeg", jpeg)).toBe("formato");
    });
    it("tipo não suportado é recusado como formato", async () => {
      expect(await motivo("image/svg+xml", ascii("<svg></svg>"))).toBe("formato");
    });
  });
});
