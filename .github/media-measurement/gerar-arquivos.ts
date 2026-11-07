// Fase 60.4.3.4.4 — gera os arquivos REPRESENTATIVOS das medições (mesmos da Fase 60.4.3.4.2), sem depender do código do
// projeto. Uso: bun --no-env-file gerar-arquivos.ts <dir dos fixtures do repo> <dir de saída>
// Saída: os arquivos + manifesto.json (bytes, dimensões declaradas, SHA-256).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const [FIX, DEST] = [process.argv[2] ?? "/fixtures", process.argv[3] ?? "/saida/arquivos"];
mkdirSync(DEST, { recursive: true });
Bun.Image.backend = "bun";
const cat = (...p: Uint8Array[]) => new Uint8Array(Buffer.concat(p));
const be32 = (n: number) => { const o = new Uint8Array(4); new DataView(o.buffer).setUint32(0, n); return o; };
const TAB = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = TAB[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t: string, d: Uint8Array) => { const tb = cat(new TextEncoder().encode(t), d); return cat(be32(d.length), tb, be32(crc(tb))); };
const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(w: number, h: number, ruido: number): Uint8Array {
  const d = new Uint8Array(13); const v = new DataView(d.buffer); v.setUint32(0, w); v.setUint32(4, h); d[8] = 8; d[9] = 2;
  const L = 1 + w * 3, raw = new Uint8Array(L * h); let s = 99;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { s = (s * 1103515245 + 12345) >>> 0; const r = ruido ? (s >>> 24) % ruido : 0, o = y * L + 1 + x * 3; raw[o] = ((x * 255) / w + r) & 255; raw[o + 1] = ((y * 255) / h + r) & 255; raw[o + 2] = (((x + y) * 128) / (w + h) + r) & 255; }
  return cat(SIG, chunk("IHDR", d), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array(0)));
}

/** GIF 89a com `n` quadros w×h, paleta de 256 cores e LZW real de 9 bits ("clear" a cada 250 códigos). */
function gif(w: number, h: number, n: number): Uint8Array {
  const paleta = new Uint8Array(768); for (let i = 0; i < 256; i++) { paleta[i * 3] = i; paleta[i * 3 + 1] = 255 - i; paleta[i * 3 + 2] = (i * 7) & 255; }
  const partes: Uint8Array[] = [new TextEncoder().encode("GIF89a"), new Uint8Array([w & 255, w >> 8, h & 255, h >> 8, 0xf7, 0, 0]), paleta,
    new Uint8Array([0x21, 0xff, 0x0b, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0])];
  for (let q = 0; q < n; q++) {
    let acc = 0, nb = 0; const out: number[] = [];
    const emit = (c: number) => { acc |= c << nb; nb += 9; while (nb >= 8) { out.push(acc & 255); acc >>>= 8; nb -= 8; } };
    emit(256); let desdeClear = 0;
    for (let i = 0; i < w * h; i++) { emit(((i % w) + q * 3 + Math.floor(i / w)) & 255); if (++desdeClear === 250) { emit(256); desdeClear = 0; } }
    emit(257); if (nb > 0) out.push(acc & 255);
    const sub: number[] = []; for (let i = 0; i < out.length; i += 255) { const p = out.slice(i, i + 255); sub.push(p.length, ...p); } sub.push(0);
    partes.push(new Uint8Array([0x21, 0xf9, 4, 0, 4, 0, 0, 0]), new Uint8Array([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 8]), new Uint8Array(sub));
  }
  partes.push(new Uint8Array([0x3b]));
  return cat(...partes);
}

/** MP4 progressivo H.264, 30 s / 900 amostras (quadro-chave do fixture + NAL de preenchimento), 15 MiB exatos. */
function mp4(): Uint8Array {
  const f = new Uint8Array(readFileSync(`${FIX}/mp4-h264-progressivo.mp4`)); const v = new DataView(f.buffer);
  type C = { t: string; i: number; d: number; e: number };
  const kids = (a: number, b: number): C[] => { const o: C[] = []; let p = a; while (p + 8 <= b) { const s = v.getUint32(p); o.push({ t: String.fromCharCode(...f.subarray(p + 4, p + 8)), i: p, d: p + 8, e: p + s }); p += s; } return o; };
  const g = (l: C[], t: string) => { const c = l.find((x) => x.t === t); if (!c) throw new Error(`sem ${t}`); return c; };
  const cp = (c: C) => f.slice(c.i, c.e);
  const box = (t: string, ...c: Uint8Array[]) => { const b = cat(...c); return cat(be32(b.length + 8), new TextEncoder().encode(t), b); };
  const top = kids(0, f.length), moov = kids(g(top, "moov").d, g(top, "moov").e), trak = kids(g(moov, "trak").d, g(moov, "trak").e);
  const mdia = kids(g(trak, "mdia").d, g(trak, "mdia").e), minf = kids(g(mdia, "minf").d, g(mdia, "minf").e), stbl = kids(g(minf, "stbl").d, g(minf, "stbl").e);
  const chave = f.slice(g(top, "mdat").d, g(top, "mdat").e);
  const N = 900, porAmostra = Math.floor((15 * 1024 * 1024 - 64 * 1024) / N);
  const preench = porAmostra - chave.length - 4; const filler = new Uint8Array(preench); filler[0] = 0x0c; filler.fill(0xff, 1, preench - 1); filler[preench - 1] = 0x80;
  const amostra = cat(chave, be32(preench), filler);
  const mdhd = cp(g(mdia, "mdhd")); const vm = new DataView(mdhd.buffer); const v1 = mdhd[8] === 1; const ts = vm.getUint32(v1 ? 28 : 20);
  if (v1) vm.setBigUint64(32, BigInt(30 * ts)); else vm.setUint32(24, 30 * ts);
  const z = (n: number) => new Uint8Array(n);
  const montar = (off: number) => box("moov", cp(g(moov, "mvhd")), box("trak", cp(g(trak, "tkhd")), box("mdia", mdhd, cp(g(mdia, "hdlr")), box("minf", cp(g(minf, "vmhd")), cp(g(minf, "dinf")), box("stbl", cp(g(stbl, "stsd")), box("stts", z(4), be32(1), be32(N), be32(ts / 30)), box("stsc", z(4), be32(1), be32(1), be32(N), be32(1)), box("stsz", z(4), be32(amostra.length), be32(N)), box("stco", z(4), be32(1), be32(off)))))));
  const ftyp = cp(g(top, "ftyp")); const off = ftyp.length + montar(0).length + 8;
  const base = cat(ftyp, montar(off), box("mdat", ...Array.from({ length: N }, () => amostra)));
  const falta = 15 * 1024 * 1024 - base.length;
  return cat(base, be32(falta), new TextEncoder().encode("free"), z(falta - 8));
}

const jpegFoto = await new Bun.Image(png(4000, 3000, 24)).jpeg({ quality: 92 }).bytes();
const arquivos: { nome: string; mime: string; bytes: Uint8Array; descricao: string; esperado: "aceito" | "recusado" }[] = [
  { nome: "jpeg-4000x3000.jpg", mime: "image/jpeg", bytes: jpegFoto, descricao: "foto sintética 4000×3000 (12 MP), q92", esperado: "aceito" },
  { nome: "png-5000x5000.png", mime: "image/png", bytes: png(5000, 5000, 0), descricao: "gradiente 5000×5000 (25 MP exatos)", esperado: "aceito" },
  { nome: "webp-5000x5000.webp", mime: "image/webp", bytes: await new Bun.Image(png(5000, 5000, 6)).webp({ quality: 75 }).bytes(), descricao: "foto sintética 5000×5000 (25 MP), q75", esperado: "aceito" },
  { nome: "gif-200x150-100q.gif", mime: "image/gif", bytes: gif(200, 150, 100), descricao: "100 quadros 200×150, LZW real", esperado: "aceito" },
  { nome: "mp4-h264-30s-900amostras.mp4", mime: "video/mp4", bytes: mp4(), descricao: "H.264 progressivo, 30 s, 900 amostras, 15 MiB exatos", esperado: "aceito" },
  { nome: "invalido-n8.jpg", mime: "image/jpeg", bytes: new Uint8Array(readFileSync(`${FIX}/n8-jpeg-corrompido.jpg`)), descricao: "N8 da bateria 60.4.3.3.2", esperado: "recusado" },
  { nome: "invalido-jpeg-truncado.jpg", mime: "image/jpeg", bytes: jpegFoto.slice(0, jpegFoto.length >> 1), descricao: "JPEG 12 MP truncado em 50%", esperado: "recusado" },
];
const manifesto = arquivos.map(({ nome, mime, bytes, descricao, esperado }) => {
  writeFileSync(`${DEST}/${nome}`, bytes);
  return { nome, mime, bytes: bytes.length, descricao, esperado, sha256: createHash("sha256").update(bytes).digest("hex") };
});
writeFileSync(`${DEST}/manifesto.json`, JSON.stringify(manifesto, null, 2));
console.log(JSON.stringify(manifesto.map(({ nome, bytes, sha256 }) => ({ nome, bytes, sha256: sha256.slice(0, 16) }))));
