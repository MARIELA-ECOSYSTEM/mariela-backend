import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CriarVendedorDto } from "./criar-vendedor.dto.js";
import { ListarVendedoresQueryDto } from "./listar-vendedores-query.dto.js";

describe("CriarVendedorDto", () => {
  it("aceita um payload válido mínimo (com senha)", async () => {
    const dto = plainToInstance(CriarVendedorDto, {
      nome: "Mariana Alves",
      telefone: "(11) 99444-1122",
      ativo: true,
      senha: "senha123",
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("aceita um payload sem senha (válido para atualização, não para criação)", async () => {
    const dto = plainToInstance(CriarVendedorDto, {
      nome: "Mariana Alves",
      telefone: "(11) 99444-1122",
      ativo: true,
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita nome vazio", async () => {
    const dto = plainToInstance(CriarVendedorDto, { nome: "", telefone: "(11) 99444-1122", ativo: true });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });

  it("rejeita telefone ausente", async () => {
    const dto = plainToInstance(CriarVendedorDto, { nome: "Mariana Alves", ativo: true });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "telefone")).toBe(true);
  });

  it("rejeita senha menor que o mínimo", async () => {
    const dto = plainToInstance(CriarVendedorDto, {
      nome: "Mariana Alves",
      telefone: "(11) 99444-1122",
      ativo: true,
      senha: "123",
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "senha")).toBe(true);
  });

  it("rejeita data de nascimento em formato inválido", async () => {
    const dto = plainToInstance(CriarVendedorDto, {
      nome: "Mariana Alves",
      telefone: "(11) 99444-1122",
      ativo: true,
      dataNascimento: "12/03/1994",
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "dataNascimento")).toBe(true);
  });

  it("rejeita nome acima de 120 caracteres", async () => {
    const dto = plainToInstance(CriarVendedorDto, {
      nome: "A".repeat(121),
      telefone: "(11) 99444-1122",
      ativo: true,
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });
});

describe("ListarVendedoresQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarVendedoresQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.ordenarPor).toBe("nome");
    expect(dto.ordem).toBe("asc");
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.status).toEqual([]);
  });

  it("rejeita ordenarPor fora da whitelist", async () => {
    const dto = plainToInstance(ListarVendedoresQueryDto, { ordenarPor: "senhaHash" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "ordenarPor")).toBe(true);
  });

  it("transforma CSV de facetas em lista", async () => {
    const dto = plainToInstance(ListarVendedoresQueryDto, { vendas: "sem,21+" });
    expect(dto.vendas).toEqual(["sem", "21+"]);
  });

  it("rejeita limit acima do máximo permitido", async () => {
    const dto = plainToInstance(ListarVendedoresQueryDto, { limit: "500" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });
});
