import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CriarCampanhaDto } from "./criar-campanha.dto.js";
import { ListarCampanhasQueryDto } from "./listar-campanhas-query.dto.js";

describe("CriarCampanhaDto", () => {
  it("aceita um payload válido mínimo", async () => {
    const dto = plainToInstance(CriarCampanhaDto, { nome: "Lançamento Verão", inicio: "2026-01-01", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita nome vazio", async () => {
    const dto = plainToInstance(CriarCampanhaDto, { nome: "", inicio: "2026-01-01", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });

  it("rejeita início ausente", async () => {
    const dto = plainToInstance(CriarCampanhaDto, { nome: "Lançamento Verão", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "inicio")).toBe(true);
  });

  it("rejeita data em formato inválido", async () => {
    const dto = plainToInstance(CriarCampanhaDto, { nome: "Lançamento Verão", inicio: "01/01/2026", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "inicio")).toBe(true);
  });

  it("aceita destaque/banner ausentes (assumem false no service)", async () => {
    const dto = plainToInstance(CriarCampanhaDto, { nome: "Lançamento Verão", inicio: "2026-01-01", fim: "2026-03-31" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita nome acima de 120 caracteres", async () => {
    const dto = plainToInstance(CriarCampanhaDto, {
      nome: "A".repeat(121),
      inicio: "2026-01-01",
      fim: "2026-03-31",
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });
});

describe("ListarCampanhasQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarCampanhasQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.ordenarPor).toBe("nome");
    expect(dto.ordem).toBe("asc");
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.situacao).toEqual([]);
  });

  it("rejeita ordenarPor fora da whitelist", async () => {
    const dto = plainToInstance(ListarCampanhasQueryDto, { ordenarPor: "codigo" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "ordenarPor")).toBe(true);
  });

  it("transforma CSV de facetas em lista", async () => {
    const dto = plainToInstance(ListarCampanhasQueryDto, { situacao: "ativa,agendada" });
    expect(dto.situacao).toEqual(["ativa", "agendada"]);
  });

  it("rejeita limit acima do máximo permitido", async () => {
    const dto = plainToInstance(ListarCampanhasQueryDto, { limit: "500" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });
});
