import { describe, expect, it } from "bun:test";
import {
  conflitoTamanhoUnico,
  formatarCodigoVariante,
  normalizarCor,
  normalizarSegmentoCodigo,
  normalizarTamanho,
} from "./normalizacao.util.js";

describe("normalizarCor", () => {
  it("trata maiúsculas/minúsculas como a mesma cor", () => {
    expect(normalizarCor("Preto")).toBe(normalizarCor("preto"));
    expect(normalizarCor("PRETO")).toBe(normalizarCor("preto"));
  });

  it("ignora acentos (Rosé === Rose)", () => {
    expect(normalizarCor("Rosé")).toBe(normalizarCor("Rose"));
  });

  it("tolera espaços extras", () => {
    expect(normalizarCor("  Azul   Marinho  ")).toBe(normalizarCor("Azul Marinho"));
  });

  it("preserva a distinção entre cores realmente diferentes", () => {
    expect(normalizarCor("Preto")).not.toBe(normalizarCor("Branco"));
  });
});

describe("normalizarTamanho", () => {
  it("normaliza para maiúsculas e remove espaços", () => {
    expect(normalizarTamanho(" m ")).toBe("M");
    expect(normalizarTamanho("u")).toBe("U");
  });
});

describe("conflitoTamanhoUnico", () => {
  it("bloqueia adicionar U quando já existem outros tamanhos", () => {
    expect(conflitoTamanhoUnico(["P", "M"], "U")).not.toBeNull();
  });

  it("bloqueia adicionar outro tamanho quando já existe U", () => {
    expect(conflitoTamanhoUnico(["U"], "P")).not.toBeNull();
  });

  it("permite o primeiro tamanho normal", () => {
    expect(conflitoTamanhoUnico([], "M")).toBeNull();
  });

  it("permite o primeiro U", () => {
    expect(conflitoTamanhoUnico([], "U")).toBeNull();
  });
});

describe("formatarCodigoVariante", () => {
  it("deriva o código da variante do código do produto + cor normalizada", () => {
    expect(formatarCodigoVariante("PROD-0001", "Azul Marinho")).toBe("PROD-0001-AZUL-MARINHO");
  });

  it("remove acentos e caracteres especiais no segmento", () => {
    expect(normalizarSegmentoCodigo("Rosé!!")).toBe("ROSE");
  });
});
