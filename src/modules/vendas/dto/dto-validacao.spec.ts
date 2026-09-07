import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BaixarParcelaDto } from "./baixar-parcela.dto.js";
import { CancelamentoDto } from "./cancelamento.dto.js";
import { ListarVendasQueryDto } from "./listar-vendas-query.dto.js";

describe("BaixarParcelaDto", () => {
  it("aceita payload vazio (mantém a forma de pagamento da venda)", async () => {
    const dto = plainToInstance(BaixarParcelaDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("aceita formaPagamento informada", async () => {
    const dto = plainToInstance(BaixarParcelaDto, { formaPagamento: "PIX" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });
});

describe("CancelamentoDto", () => {
  it("aceita cancelamento integral com motivo", async () => {
    const dto = plainToInstance(CancelamentoDto, { tipo: "integral", motivo: "Cliente desistiu." });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita motivo vazio", async () => {
    const dto = plainToInstance(CancelamentoDto, { tipo: "integral", motivo: "" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "motivo")).toBe(true);
  });

  it("rejeita tipo fora do enum", async () => {
    const dto = plainToInstance(CancelamentoDto, { tipo: "total", motivo: "Teste" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "tipo")).toBe(true);
  });

  it("aceita devolução parcial com itens", async () => {
    const dto = plainToInstance(CancelamentoDto, {
      tipo: "parcial",
      motivo: "Peça com defeito",
      itens: [{ itemId: "abc123", quantidade: 1 }],
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita item de devolução com quantidade inválida", async () => {
    const dto = plainToInstance(CancelamentoDto, {
      tipo: "parcial",
      motivo: "Peça com defeito",
      itens: [{ itemId: "abc123", quantidade: 0 }],
    });
    const erros = await validate(dto);
    expect(erros.length).toBeGreaterThan(0);
  });
});

describe("ListarVendasQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarVendasQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.ordenarPor).toBe("data");
    expect(dto.ordem).toBe("desc");
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.status).toEqual([]);
  });

  it("rejeita ordenarPor fora da whitelist", async () => {
    const dto = plainToInstance(ListarVendasQueryDto, { ordenarPor: "codigo" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "ordenarPor")).toBe(true);
  });

  it("transforma CSV de facetas em lista", async () => {
    const dto = plainToInstance(ListarVendasQueryDto, { status: "em_pagamento,concluida" });
    expect(dto.status).toEqual(["em_pagamento", "concluida"]);
  });

  it("rejeita limit acima do máximo permitido", async () => {
    const dto = plainToInstance(ListarVendasQueryDto, { limit: "500" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });
});
