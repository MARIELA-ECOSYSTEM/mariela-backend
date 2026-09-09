import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BaixarParcelaDto } from "./baixar-parcela.dto.js";
import { CancelamentoDto } from "./cancelamento.dto.js";
import { ListarVendasQueryDto } from "./listar-vendas-query.dto.js";
import { RegistrarRecebimentoDto } from "./registrar-recebimento.dto.js";

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

  it("aceita idempotencyKey opcional", async () => {
    const dto = plainToInstance(BaixarParcelaDto, { idempotencyKey: "chave-123" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita idempotencyKey vazia quando informada (Etapa 10.17)", async () => {
    const dto = plainToInstance(BaixarParcelaDto, { idempotencyKey: "" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "idempotencyKey")).toBe(true);
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

describe("RegistrarRecebimentoDto", () => {
  it("aceita recebimento simples em dinheiro", async () => {
    const dto = plainToInstance(RegistrarRecebimentoDto, { forma: "Dinheiro", valor: 100 });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita forma vazia", async () => {
    const dto = plainToInstance(RegistrarRecebimentoDto, { forma: "", valor: 100 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "forma")).toBe(true);
  });

  it("rejeita valor zero ou negativo", async () => {
    const dto = plainToInstance(RegistrarRecebimentoDto, { forma: "Dinheiro", valor: 0 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "valor")).toBe(true);
  });

  it("rejeita valor ausente", async () => {
    const dto = plainToInstance(RegistrarRecebimentoDto, { forma: "Dinheiro" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "valor")).toBe(true);
  });

  it("aceita modalidade credito com adquirenteId e parcelas", async () => {
    const dto = plainToInstance(RegistrarRecebimentoDto, {
      forma: "Crédito",
      valor: 300,
      modalidade: "credito",
      adquirenteId: "65f1a2b3c4d5e6f7a8b9c0d1",
      parcelas: 3,
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita modalidade fora do enum", async () => {
    const dto = plainToInstance(RegistrarRecebimentoDto, { forma: "Cartão", valor: 100, modalidade: "boleto" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "modalidade")).toBe(true);
  });

  it("aceita idempotencyKey opcional", async () => {
    const dto = plainToInstance(RegistrarRecebimentoDto, { forma: "Dinheiro", valor: 100, idempotencyKey: "chave-123" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita idempotencyKey vazia quando informada", async () => {
    const dto = plainToInstance(RegistrarRecebimentoDto, { forma: "Dinheiro", valor: 100, idempotencyKey: "" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "idempotencyKey")).toBe(true);
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
