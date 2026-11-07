import { describe, expect, it } from "bun:test";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { prefixoDoFormato } from "../../test-utils/media-storage-falso.util.js";
import { assinaturaDoFormatoConfere, validarArquivoDeclarado } from "./media-validacao.util.js";

const bytes = (...valores: number[]) => new Uint8Array(valores);
const ascii = (texto: string) => [...texto].map((caractere) => caractere.charCodeAt(0));

describe("assinaturaDoFormatoConfere (Fase 60.1)", () => {
  it("aceita o cabeçalho real de cada formato permitido", () => {
    for (const formato of ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"]) {
      expect(assinaturaDoFormatoConfere(formato, prefixoDoFormato(formato, 16))).toBe(true);
    }
  });

  it("recusa conteúdo de outro formato declarado como imagem/vídeo (ex.: HTML como PNG)", () => {
    const html = prefixoDoFormato("text/html", 16);
    for (const formato of ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"]) {
      expect(assinaturaDoFormatoConfere(formato, html)).toBe(false);
    }
    expect(assinaturaDoFormatoConfere("image/png", prefixoDoFormato("image/jpeg", 16))).toBe(false);
  });

  it("WebP exige RIFF no início E WEBP no deslocamento 8 (RIFF de WAV não passa)", () => {
    expect(assinaturaDoFormatoConfere("image/webp", bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")))).toBe(false);
    expect(assinaturaDoFormatoConfere("image/webp", bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")))).toBe(true);
  });

  it("MP4 exige ftyp exatamente no deslocamento 4", () => {
    expect(assinaturaDoFormatoConfere("video/mp4", bytes(...ascii("ftyp"), 0, 0, 0, 0))).toBe(false);
    expect(assinaturaDoFormatoConfere("video/mp4", bytes(0, 0, 0, 0x20, ...ascii("ftyp")))).toBe(true);
  });

  it("conteúdo truncado (menos bytes que a assinatura) ou vazio é recusado", () => {
    expect(assinaturaDoFormatoConfere("image/jpeg", bytes(0xff, 0xd8))).toBe(false);
    expect(assinaturaDoFormatoConfere("image/webp", bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEB")))).toBe(false);
    expect(assinaturaDoFormatoConfere("image/png", new Uint8Array(0))).toBe(false);
  });

  it("MIME fora da lista nunca confere", () => {
    expect(assinaturaDoFormatoConfere("image/svg+xml", bytes(...ascii("<svg")))).toBe(false);
  });
});

describe("validarArquivoDeclarado (compartilhada pelo upload antigo e pela galeria)", () => {
  it("devolve a extensão canônica", () => {
    expect(validarArquivoDeclarado({ fileName: "Foto.JPEG", contentType: "image/jpeg", kind: "image", size: 10 })).toEqual({ extensao: "jpg" });
    expect(validarArquivoDeclarado({ fileName: "v.mp4", contentType: "video/mp4", kind: "video", size: 10 })).toEqual({ extensao: "mp4" });
  });

  it("acumula os erros por campo", () => {
    try {
      validarArquivoDeclarado({ fileName: "foto.png", contentType: "image/jpeg", kind: "image", size: 6 * 1024 * 1024 });
      throw new Error("deveria ter falhado");
    } catch (erro) {
      expect(erro).toBeInstanceOf(ApiException);
      expect((erro as ApiException).errors.map((e) => e.field)).toEqual(["fileName", "size"]);
    }
  });
});
