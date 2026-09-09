import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AdicionarItemListaDto } from "./adicionar-item-lista.dto.js";
import { AtualizarLojaDto } from "./atualizar-loja.dto.js";

function enderecoValido() {
  return { cep: "01310-100", logradouro: "Av. Paulista", numero: "1000", complemento: "", bairro: "Bela Vista", cidade: "São Paulo", estado: "SP" };
}

describe("AtualizarLojaDto", () => {
  it("aceita payload completo válido", async () => {
    const dto = plainToInstance(AtualizarLojaDto, {
      nome: "Loja Exemplo",
      logo: "https://exemplo.com/logo.png",
      telefone: "1130000000",
      whatsapp: "11999990000",
      email: "contato@loja.com",
      endereco: enderecoValido(),
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("aceita campos vazios (nenhum é obrigatoriamente não-vazio)", async () => {
    const dto = plainToInstance(AtualizarLojaDto, {
      nome: "",
      logo: "",
      telefone: "",
      whatsapp: "",
      email: "",
      endereco: { cep: "", logradouro: "", numero: "", complemento: "", bairro: "", cidade: "", estado: "" },
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita endereco ausente", async () => {
    const dto = plainToInstance(AtualizarLojaDto, { nome: "Loja", logo: "", telefone: "", whatsapp: "", email: "" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "endereco")).toBe(true);
  });

  it("rejeita campo de endereco com tipo errado", async () => {
    const dto = plainToInstance(AtualizarLojaDto, {
      nome: "Loja",
      logo: "",
      telefone: "",
      whatsapp: "",
      email: "",
      endereco: { ...enderecoValido(), numero: 1000 },
    });
    const erros = await validate(dto);
    const enderecoErro = erros.find((erro) => erro.property === "endereco");
    expect(enderecoErro?.children?.some((filho) => filho.property === "numero")).toBe(true);
  });
});

describe("AdicionarItemListaDto", () => {
  it("aceita valor não vazio", async () => {
    const dto = plainToInstance(AdicionarItemListaDto, { valor: "Vestidos" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita valor vazio", async () => {
    const dto = plainToInstance(AdicionarItemListaDto, { valor: "" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "valor")).toBe(true);
  });

  it("rejeita valor ausente", async () => {
    const dto = plainToInstance(AdicionarItemListaDto, {});
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "valor")).toBe(true);
  });
});
