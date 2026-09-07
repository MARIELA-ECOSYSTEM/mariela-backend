import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AdicionarTamanhoDto } from "./adicionar-tamanho.dto.js";
import { CriarProdutoDto } from "./criar-produto.dto.js";
import { EntradaEstoqueDto } from "../../estoque/dto/entrada-estoque.dto.js";

describe("AdicionarTamanhoDto", () => {
  it("rejeita quantidade negativa", async () => {
    const dto = plainToInstance(AdicionarTamanhoDto, { tamanho: "M", quantidade: -1 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "quantidade")).toBe(true);
  });

  it("aceita quantidade zero", async () => {
    const dto = plainToInstance(AdicionarTamanhoDto, { tamanho: "M", quantidade: 0 });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });
});

describe("CriarProdutoDto", () => {
  it("rejeita preço de custo zero ou negativo", async () => {
    const dto = plainToInstance(CriarProdutoDto, {
      nome: "Vestido",
      categoria: "Vestidos",
      precoCusto: 0,
      precoVenda: 100,
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "precoCusto")).toBe(true);
  });

  it("rejeita nome vazio", async () => {
    const dto = plainToInstance(CriarProdutoDto, {
      nome: "",
      categoria: "Vestidos",
      precoCusto: 10,
      precoVenda: 20,
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });

  it("aceita um payload válido completo", async () => {
    const dto = plainToInstance(CriarProdutoDto, {
      nome: "Vestido Midi",
      categoria: "Vestidos",
      precoCusto: 89.9,
      precoVenda: 259.9,
      ehNovidade: true,
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });
});

describe("EntradaEstoqueDto", () => {
  it("rejeita quantidade zero ou negativa", async () => {
    const dto = plainToInstance(EntradaEstoqueDto, {
      produtoId: "65f1a2b3c4d5e6f7a8b9c0d1",
      varianteId: "65f1a2b3c4d5e6f7a8b9c0d2",
      quantidade: 0,
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "quantidade")).toBe(true);
  });
});
