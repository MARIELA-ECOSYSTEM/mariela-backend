import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { EntradaEstoqueDto } from "./entrada-estoque.dto.js";
import { ListarEstoqueQueryDto } from "./listar-estoque-query.dto.js";
import { SaidaEstoqueDto } from "./saida-estoque.dto.js";

const ID_VALIDO = "65f1a2b3c4d5e6f7a8b9c0d1";

describe("EntradaEstoqueDto", () => {
  it("aceita entrada em um tamanho existente (tamanhoId)", async () => {
    const dto = plainToInstance(EntradaEstoqueDto, { produtoId: ID_VALIDO, varianteId: ID_VALIDO, tamanhoId: ID_VALIDO, quantidade: 5 });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("aceita entrada criando um tamanho novo (nome do tamanho, sem tamanhoId)", async () => {
    const dto = plainToInstance(EntradaEstoqueDto, { produtoId: ID_VALIDO, varianteId: ID_VALIDO, tamanho: "M", quantidade: 5 });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita produtoId/varianteId em formato inválido", async () => {
    const dto = plainToInstance(EntradaEstoqueDto, { produtoId: "abc", varianteId: "abc", tamanho: "M", quantidade: 5 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "produtoId")).toBe(true);
    expect(erros.some((erro) => erro.property === "varianteId")).toBe(true);
  });

  it("rejeita quantidade zero, negativa ou não inteira", async () => {
    for (const quantidade of [0, -1, 1.5]) {
      const dto = plainToInstance(EntradaEstoqueDto, { produtoId: ID_VALIDO, varianteId: ID_VALIDO, tamanho: "M", quantidade });
      const erros = await validate(dto);
      expect(erros.some((erro) => erro.property === "quantidade")).toBe(true);
    }
  });

  it("rejeita quantidade ausente", async () => {
    const dto = plainToInstance(EntradaEstoqueDto, { produtoId: ID_VALIDO, varianteId: ID_VALIDO, tamanho: "M" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "quantidade")).toBe(true);
  });
});

describe("SaidaEstoqueDto", () => {
  it("aceita payload válido completo", async () => {
    const dto = plainToInstance(SaidaEstoqueDto, {
      produtoId: ID_VALIDO,
      varianteId: ID_VALIDO,
      tamanhoId: ID_VALIDO,
      quantidade: 2,
      motivo: "Peça avariada",
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita motivo ausente ou vazio", async () => {
    const semMotivo = plainToInstance(SaidaEstoqueDto, { produtoId: ID_VALIDO, varianteId: ID_VALIDO, tamanhoId: ID_VALIDO, quantidade: 2 });
    expect((await validate(semMotivo)).some((erro) => erro.property === "motivo")).toBe(true);

    const motivoVazio = plainToInstance(SaidaEstoqueDto, {
      produtoId: ID_VALIDO,
      varianteId: ID_VALIDO,
      tamanhoId: ID_VALIDO,
      quantidade: 2,
      motivo: "",
    });
    expect((await validate(motivoVazio)).some((erro) => erro.property === "motivo")).toBe(true);
  });

  it("rejeita tamanhoId ausente (saída nunca cria tamanho novo)", async () => {
    const dto = plainToInstance(SaidaEstoqueDto, { produtoId: ID_VALIDO, varianteId: ID_VALIDO, quantidade: 2, motivo: "Teste" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "tamanhoId")).toBe(true);
  });

  it("rejeita quantidade zero ou negativa", async () => {
    for (const quantidade of [0, -2]) {
      const dto = plainToInstance(SaidaEstoqueDto, { produtoId: ID_VALIDO, varianteId: ID_VALIDO, tamanhoId: ID_VALIDO, quantidade, motivo: "Teste" });
      const erros = await validate(dto);
      expect(erros.some((erro) => erro.property === "quantidade")).toBe(true);
    }
  });
});

describe("ListarEstoqueQueryDto", () => {
  it("aceita payload vazio (todos os campos são opcionais)", async () => {
    const dto = plainToInstance(ListarEstoqueQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita disponibilidade fora do enum", async () => {
    const dto = plainToInstance(ListarEstoqueQueryDto, { disponibilidade: "todos" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "disponibilidade")).toBe(true);
  });
});
