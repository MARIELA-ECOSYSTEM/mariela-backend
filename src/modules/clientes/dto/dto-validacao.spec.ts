import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CriarClienteDto } from "./criar-cliente.dto.js";
import { ListarClientesQueryDto } from "./listar-clientes-query.dto.js";

describe("CriarClienteDto", () => {
  it("aceita um payload válido mínimo", async () => {
    const dto = plainToInstance(CriarClienteDto, { nome: "Maria Souza", telefone: "(83) 99999-9999" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita nome vazio", async () => {
    const dto = plainToInstance(CriarClienteDto, { nome: "", telefone: "(83) 99999-9999" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });

  it("rejeita telefone ausente", async () => {
    const dto = plainToInstance(CriarClienteDto, { nome: "Maria Souza" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "telefone")).toBe(true);
  });

  it("rejeita data de nascimento em formato inválido", async () => {
    const dto = plainToInstance(CriarClienteDto, {
      nome: "Maria Souza",
      telefone: "(83) 99999-9999",
      dataNascimento: "20/05/1998",
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "dataNascimento")).toBe(true);
  });

  it("aceita data de nascimento em ISO (YYYY-MM-DD)", async () => {
    const dto = plainToInstance(CriarClienteDto, {
      nome: "Maria Souza",
      telefone: "(83) 99999-9999",
      dataNascimento: "1998-05-20",
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita nome acima de 120 caracteres", async () => {
    const dto = plainToInstance(CriarClienteDto, {
      nome: "A".repeat(121),
      telefone: "(83) 99999-9999",
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });
});

describe("ListarClientesQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarClientesQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.ordenarPor).toBe("nome");
    expect(dto.ordem).toBe("asc");
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.recencia).toEqual([]);
  });

  it("rejeita ordenarPor fora da whitelist", async () => {
    const dto = plainToInstance(ListarClientesQueryDto, { ordenarPor: "cpf" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "ordenarPor")).toBe(true);
  });

  it("transforma CSV de facetas em lista", async () => {
    const dto = plainToInstance(ListarClientesQueryDto, { historico: "com,recorrente" });
    expect(dto.historico).toEqual(["com", "recorrente"]);
  });

  it("rejeita limit acima do máximo permitido", async () => {
    const dto = plainToInstance(ListarClientesQueryDto, { limit: "500" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });
});
