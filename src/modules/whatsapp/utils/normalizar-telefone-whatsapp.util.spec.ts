import { describe, expect, it } from "bun:test";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import { normalizarTelefoneParaWhatsapp } from "./normalizar-telefone-whatsapp.util.js";

describe("normalizarTelefoneParaWhatsapp", () => {
  it("normaliza um telefone com máscara e 11 dígitos (celular)", () => {
    expect(normalizarTelefoneParaWhatsapp("(83) 98656-7915")).toBe("+5583986567915");
  });

  it("normaliza um telefone com 10 dígitos (fixo)", () => {
    expect(normalizarTelefoneParaWhatsapp("(83) 3222-1111")).toBe("+558332221111");
  });

  it("normaliza um telefone já com DDI 55", () => {
    expect(normalizarTelefoneParaWhatsapp("+55 83 98656-7915")).toBe("+5583986567915");
  });

  it("normaliza um telefone só com dígitos, sem máscara", () => {
    expect(normalizarTelefoneParaWhatsapp("83986567915")).toBe("+5583986567915");
  });

  it("rejeita telefone com menos de 10 dígitos", () => {
    expect(() => normalizarTelefoneParaWhatsapp("8398656")).toThrow(ApiException);
  });

  it("rejeita telefone com mais de 11 dígitos (sem ser um DDI 55 reconhecível)", () => {
    expect(() => normalizarTelefoneParaWhatsapp("839865679150000")).toThrow(ApiException);
  });

  it("rejeita string vazia", () => {
    expect(() => normalizarTelefoneParaWhatsapp("")).toThrow(ApiException);
  });

  it("o erro lançado usa o código WHATSAPP_INVALID_NUMBER", () => {
    try {
      normalizarTelefoneParaWhatsapp("123");
      throw new Error("deveria ter lançado");
    } catch (erro) {
      expect(erro).toBeInstanceOf(ApiException);
      expect((erro as ApiException).code).toBe("WHATSAPP_INVALID_NUMBER");
    }
  });
});
