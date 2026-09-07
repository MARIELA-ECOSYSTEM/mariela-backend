import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AbrirCaixaDto } from "./abrir-caixa.dto.js";
import { EntradaCaixaDto } from "./entrada-caixa.dto.js";
import { SaidaCaixaDto } from "./saida-caixa.dto.js";
import { FechamentoCaixaDto } from "./fechamento-caixa.dto.js";
import { ListarCaixasQueryDto } from "./listar-caixas-query.dto.js";
import { ListarMovimentosQueryDto } from "./listar-movimentos-query.dto.js";

describe("AbrirCaixaDto", () => {
  it("aceita um payload válido mínimo", async () => {
    const dto = plainToInstance(AbrirCaixaDto, { valorInicial: 100 });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita valorInicial negativo", async () => {
    const dto = plainToInstance(AbrirCaixaDto, { valorInicial: -10 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "valorInicial")).toBe(true);
  });

  it("rejeita valorInicial ausente", async () => {
    const dto = plainToInstance(AbrirCaixaDto, {});
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "valorInicial")).toBe(true);
  });

  it("aceita valorInicial zero", async () => {
    const dto = plainToInstance(AbrirCaixaDto, { valorInicial: 0 });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });
});

describe("EntradaCaixaDto", () => {
  it("aceita um payload válido", async () => {
    const dto = plainToInstance(EntradaCaixaDto, {
      descricao: "Suprimento de troco",
      valor: 50,
      formaPagamento: "Dinheiro",
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita descrição vazia", async () => {
    const dto = plainToInstance(EntradaCaixaDto, { descricao: "", valor: 50, formaPagamento: "Dinheiro" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "descricao")).toBe(true);
  });

  it("rejeita valor zero ou negativo", async () => {
    const dto = plainToInstance(EntradaCaixaDto, { descricao: "Ajuste", valor: 0, formaPagamento: "Dinheiro" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "valor")).toBe(true);
  });

  it("rejeita forma de pagamento ausente", async () => {
    const dto = plainToInstance(EntradaCaixaDto, { descricao: "Ajuste", valor: 50 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "formaPagamento")).toBe(true);
  });
});

describe("SaidaCaixaDto", () => {
  it("aceita um payload válido com motivo", async () => {
    const dto = plainToInstance(SaidaCaixaDto, {
      descricao: "Compra de material",
      valor: 30,
      formaPagamento: "Dinheiro",
      motivo: "Material de limpeza",
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita motivo ausente", async () => {
    const dto = plainToInstance(SaidaCaixaDto, { descricao: "Compra", valor: 30, formaPagamento: "Dinheiro" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "motivo")).toBe(true);
  });
});

describe("FechamentoCaixaDto", () => {
  it("aceita um payload válido", async () => {
    const dto = plainToInstance(FechamentoCaixaDto, { valorInformado: 1250.5 });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita valorInformado negativo", async () => {
    const dto = plainToInstance(FechamentoCaixaDto, { valorInformado: -1 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "valorInformado")).toBe(true);
  });
});

describe("ListarCaixasQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarCaixasQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.ordenarPor).toBe("data");
    expect(dto.ordem).toBe("desc");
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
    expect(dto.status).toEqual([]);
  });

  it("rejeita ordenarPor fora da whitelist", async () => {
    const dto = plainToInstance(ListarCaixasQueryDto, { ordenarPor: "codigo" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "ordenarPor")).toBe(true);
  });

  it("transforma CSV de facetas em lista", async () => {
    const dto = plainToInstance(ListarCaixasQueryDto, { status: "aberto,fechado" });
    expect(dto.status).toEqual(["aberto", "fechado"]);
  });

  it("rejeita limit acima do máximo permitido", async () => {
    const dto = plainToInstance(ListarCaixasQueryDto, { limit: "500" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });
});

describe("ListarMovimentosQueryDto", () => {
  it("aplica os defaults quando nada é informado", async () => {
    const dto = plainToInstance(ListarMovimentosQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.ordem).toBe("desc");
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(50);
  });

  it("rejeita limit acima do máximo permitido", async () => {
    const dto = plainToInstance(ListarMovimentosQueryDto, { limit: "1000" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "limit")).toBe(true);
  });
});
