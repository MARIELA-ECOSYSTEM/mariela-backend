import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CriarColecaoDto } from "./criar-colecao.dto.js";
import { ListarColecoesQueryDto } from "./listar-colecoes-query.dto.js";

describe("CriarColecaoDto", () => {
  it("aceita um payload válido mínimo", async () => {
    const dto = plainToInstance(CriarColecaoDto, { nome: "Verão 2026", inicio: "2026-01-01", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita nome vazio", async () => {
    const dto = plainToInstance(CriarColecaoDto, { nome: "", inicio: "2026-01-01", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });

  it("rejeita início ausente", async () => {
    const dto = plainToInstance(CriarColecaoDto, { nome: "Verão 2026", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "inicio")).toBe(true);
  });

  it("rejeita data em formato inválido", async () => {
    const dto = plainToInstance(CriarColecaoDto, { nome: "Verão 2026", inicio: "01/01/2026", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "inicio")).toBe(true);
  });

  it("aceita destaque/banner ausentes (assumem false no service)", async () => {
    const dto = plainToInstance(CriarColecaoDto, { nome: "Verão 2026", inicio: "2026-01-01", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita nome acima de 120 caracteres", async () => {
    const dto = plainToInstance(CriarColecaoDto, {
      nome: "A".repeat(121),
      inicio: "2026-01-01",
      fim: "2026-03-31",
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });
});

describe("ListarColecoesQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarColecoesQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.ordenarPor).toBe("nome");
    expect(dto.ordem).toBe("asc");
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.situacao).toEqual([]);
  });

  it("rejeita ordenarPor fora da whitelist", async () => {
    const dto = plainToInstance(ListarColecoesQueryDto, { ordenarPor: "codigo" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "ordenarPor")).toBe(true);
  });

  it("transforma CSV de facetas em lista", async () => {
    const dto = plainToInstance(ListarColecoesQueryDto, { situacao: "ativa,agendada" });
    expect(dto.situacao).toEqual(["ativa", "agendada"]);
  });

  it("rejeita limit acima do máximo permitido", async () => {
    const dto = plainToInstance(ListarColecoesQueryDto, { limit: "500" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });
});
