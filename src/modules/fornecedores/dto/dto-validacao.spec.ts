import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CriarFornecedorDto } from "./criar-fornecedor.dto.js";
import { ListarFornecedoresQueryDto } from "./listar-fornecedores-query.dto.js";

describe("CriarFornecedorDto", () => {
  it("aceita um payload com só o nome (todos os outros campos são opcionais)", async () => {
    const dto = plainToInstance(CriarFornecedorDto, { nome: "Confecções Ipê" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita nome vazio", async () => {
    const dto = plainToInstance(CriarFornecedorDto, { nome: "" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });

  it("rejeita nome acima de 120 caracteres", async () => {
    const dto = plainToInstance(CriarFornecedorDto, { nome: "A".repeat(121) });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });

  it("aceita telefone ausente", async () => {
    const dto = plainToInstance(CriarFornecedorDto, { nome: "Confecções Ipê" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("aceita email vazio", async () => {
    const dto = plainToInstance(CriarFornecedorDto, { nome: "Confecções Ipê", email: "" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita email em formato inválido quando informado", async () => {
    const dto = plainToInstance(CriarFornecedorDto, { nome: "Confecções Ipê", email: "invalido" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "email")).toBe(true);
  });

  it("aceita endereço parcial (nenhum campo é obrigatório)", async () => {
    const dto = plainToInstance(CriarFornecedorDto, {
      nome: "Confecções Ipê",
      endereco: { cidade: "São Paulo", estado: "SP" },
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita campo desconhecido dentro de endereco (nested validation)", async () => {
    const dto = plainToInstance(CriarFornecedorDto, {
      nome: "Confecções Ipê",
      endereco: { cidade: "A".repeat(200) },
    });
    const erros = await validate(dto);
    const erroEndereco = erros.find((erro) => erro.property === "endereco");
    expect(erroEndereco).toBeTruthy();
  });
});

describe("ListarFornecedoresQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarFornecedoresQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.ordenarPor).toBe("nome");
    expect(dto.ordem).toBe("asc");
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.produtos).toEqual([]);
  });

  it("rejeita ordenarPor fora da whitelist", async () => {
    const dto = plainToInstance(ListarFornecedoresQueryDto, { ordenarPor: "cnpj" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "ordenarPor")).toBe(true);
  });

  it("transforma CSV de facetas em lista", async () => {
    const dto = plainToInstance(ListarFornecedoresQueryDto, { produtos: "1-5,16+" });
    expect(dto.produtos).toEqual(["1-5", "16+"]);
  });

  it("rejeita limit acima do máximo permitido", async () => {
    const dto = plainToInstance(ListarFornecedoresQueryDto, { limit: "500" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });
});
