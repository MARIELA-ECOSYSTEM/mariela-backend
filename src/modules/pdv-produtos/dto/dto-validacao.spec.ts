import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ListarProdutosPdvQueryDto } from "./listar-produtos-pdv-query.dto.js";

describe("ListarProdutosPdvQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarProdutosPdvQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.ordenarPor).toBe("nome");
    expect(dto.ordem).toBe("asc");
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(30);
  });

  it("aceita busca livre", async () => {
    const dto = plainToInstance(ListarProdutosPdvQueryDto, { busca: "vestido" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita ordenarPor fora da whitelist", async () => {
    const dto = plainToInstance(ListarProdutosPdvQueryDto, { ordenarPor: "precoCusto" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "ordenarPor")).toBe(true);
  });

  it("rejeita ordem fora da whitelist", async () => {
    const dto = plainToInstance(ListarProdutosPdvQueryDto, { ordem: "aleatorio" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "ordem")).toBe(true);
  });

  it("rejeita limit acima do máximo do PDV (60)", async () => {
    const dto = plainToInstance(ListarProdutosPdvQueryDto, { limit: "100" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });

  it("aceita limit dentro do máximo do PDV", async () => {
    const dto = plainToInstance(ListarProdutosPdvQueryDto, { limit: "60" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });
});
