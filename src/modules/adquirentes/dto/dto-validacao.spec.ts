import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AtualizarAdquirenteDto } from "./atualizar-adquirente.dto.js";
import { CriarAdquirenteDto } from "./criar-adquirente.dto.js";
import { ListarAdquirentesQueryDto } from "./listar-adquirentes-query.dto.js";
import { TarifaConfigDto } from "./tarifa-config.dto.js";

describe("CriarAdquirenteDto", () => {
  it("aceita um payload válido mínimo (só nome)", async () => {
    const dto = plainToInstance(CriarAdquirenteDto, { nome: "Cielo" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita nome vazio", async () => {
    const dto = plainToInstance(CriarAdquirenteDto, { nome: "" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });

  it("rejeita nome acima de 120 caracteres", async () => {
    const dto = plainToInstance(CriarAdquirenteDto, { nome: "A".repeat(121) });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });

  it("aceita ativo/observacao/tabelaTarifas ausentes", async () => {
    const dto = plainToInstance(CriarAdquirenteDto, { nome: "Stone" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("aceita tabelaTarifas com entradas válidas", async () => {
    const dto = plainToInstance(CriarAdquirenteDto, {
      nome: "Rede",
      tabelaTarifas: [
        { modalidade: "debito", parcelas: 1, percentual: 1.99 },
        { modalidade: "credito", parcelas: 6, percentual: 5.99 },
      ],
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita entrada de tabelaTarifas com modalidade inválida", async () => {
    const dto = plainToInstance(CriarAdquirenteDto, {
      nome: "Getnet",
      tabelaTarifas: [{ modalidade: "boleto", parcelas: 1, percentual: 1 }],
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "tabelaTarifas")).toBe(true);
  });
});

describe("TarifaConfigDto", () => {
  it("aceita crédito de 1x", async () => {
    const dto = plainToInstance(TarifaConfigDto, { modalidade: "credito", parcelas: 1, percentual: 3.49 });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("aceita crédito de 24x", async () => {
    const dto = plainToInstance(TarifaConfigDto, { modalidade: "credito", parcelas: 24, percentual: 9.99 });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejeita crédito com 25x", async () => {
    const dto = plainToInstance(TarifaConfigDto, { modalidade: "credito", parcelas: 25, percentual: 9.99 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "parcelas")).toBe(true);
  });

  it("rejeita 0 parcelas", async () => {
    const dto = plainToInstance(TarifaConfigDto, { modalidade: "credito", parcelas: 0, percentual: 1 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "parcelas")).toBe(true);
  });

  it("rejeita percentual negativo", async () => {
    const dto = plainToInstance(TarifaConfigDto, { modalidade: "debito", parcelas: 1, percentual: -1 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "percentual")).toBe(true);
  });

  it("aceita percentual zero", async () => {
    const dto = plainToInstance(TarifaConfigDto, { modalidade: "debito", parcelas: 1, percentual: 0 });
    expect(await validate(dto)).toHaveLength(0);
  });
});

describe("AtualizarAdquirenteDto", () => {
  it("aceita payload vazio (nada a atualizar)", async () => {
    const dto = plainToInstance(AtualizarAdquirenteDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it("aceita atualizar só o campo ativo", async () => {
    const dto = plainToInstance(AtualizarAdquirenteDto, { ativo: false });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejeita nome vazio quando informado", async () => {
    const dto = plainToInstance(AtualizarAdquirenteDto, { nome: "" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "nome")).toBe(true);
  });
});

describe("ListarAdquirentesQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarAdquirentesQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it("rejeita limit acima do máximo", async () => {
    const dto = plainToInstance(ListarAdquirentesQueryDto, { limit: 999 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });
});
