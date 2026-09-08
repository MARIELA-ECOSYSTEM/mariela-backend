import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CriarVendaPdvDto } from "./criar-venda-pdv.dto.js";

function payloadValido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    itens: [{ produtoId: "a", varianteId: "b", tamanhoId: "c", quantidade: 1 }],
    pagamentos: [{ forma: "Dinheiro", valor: 100 }],
    ...extra,
  };
}

describe("CriarVendaPdvDto", () => {
  it("aceita um payload mínimo válido", async () => {
    const dto = plainToInstance(CriarVendaPdvDto, payloadValido());
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita idempotencyKey ausente", async () => {
    const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ idempotencyKey: undefined }));
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "idempotencyKey")).toBe(true);
  });

  it("rejeita ausência de itens", async () => {
    const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ itens: [] }));
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "itens")).toBe(true);
  });

  it("rejeita quantidade zero ou negativa", async () => {
    const zero = plainToInstance(CriarVendaPdvDto, payloadValido({ itens: [{ produtoId: "a", varianteId: "b", tamanhoId: "c", quantidade: 0 }] }));
    expect((await validate(zero)).length).toBeGreaterThan(0);

    const negativa = plainToInstance(CriarVendaPdvDto, payloadValido({ itens: [{ produtoId: "a", varianteId: "b", tamanhoId: "c", quantidade: -1 }] }));
    expect((await validate(negativa)).length).toBeGreaterThan(0);
  });

  it("rejeita quantidade não inteira", async () => {
    const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ itens: [{ produtoId: "a", varianteId: "b", tamanhoId: "c", quantidade: 1.5 }] }));
    const erros = await validate(dto);
    expect(erros.length).toBeGreaterThan(0);
  });

  it("rejeita item sem produtoId/varianteId/tamanhoId", async () => {
    const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ itens: [{ quantidade: 1 }] }));
    const erros = await validate(dto);
    expect(erros.length).toBeGreaterThan(0);
  });

  it("rejeita pagamento com valor zero ou negativo", async () => {
    const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ pagamentos: [{ forma: "Dinheiro", valor: 0 }] }));
    const erros = await validate(dto);
    expect(erros.length).toBeGreaterThan(0);
  });

  it("rejeita pagamento sem forma", async () => {
    const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ pagamentos: [{ valor: 100 }] }));
    const erros = await validate(dto);
    expect(erros.length).toBeGreaterThan(0);
  });

  it("aceita pagamentos vazios (venda 100% pendente, gera parcela)", async () => {
    const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ pagamentos: [] }));
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita descontoVenda negativo", async () => {
    const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ descontoVenda: -1 }));
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "descontoVenda")).toBe(true);
  });

  it("aceita clienteId opcional (ausente ou null)", async () => {
    const semCliente = plainToInstance(CriarVendaPdvDto, payloadValido());
    expect((await validate(semCliente)).length).toBe(0);

    const clienteNulo = plainToInstance(CriarVendaPdvDto, payloadValido({ clienteId: null }));
    expect((await validate(clienteNulo)).length).toBe(0);
  });

  describe("descontoVenda — Etapa 10.3 (number legado + objeto {tipo, valor})", () => {
    it("aceita descontoVenda como number puro (retrocompatibilidade)", async () => {
      const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ descontoVenda: 20 }));
      const erros = await validate(dto);
      expect(erros).toHaveLength(0);
      expect(dto.descontoVenda).toEqual({ tipo: "valor", valor: 20 });
    });

    it("aceita descontoVenda como objeto {tipo:'valor', valor}", async () => {
      const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ descontoVenda: { tipo: "valor", valor: 20 } }));
      expect(await validate(dto)).toHaveLength(0);
    });

    it("aceita descontoVenda como objeto {tipo:'percentual', valor}", async () => {
      const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ descontoVenda: { tipo: "percentual", valor: 10 } }));
      expect(await validate(dto)).toHaveLength(0);
    });

    it("rejeita tipo de desconto inválido", async () => {
      const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ descontoVenda: { tipo: "cupom", valor: 10 } }));
      const erros = await validate(dto);
      expect(erros.some((erro) => erro.property === "descontoVenda")).toBe(true);
    });

    it("rejeita valor negativo dentro do objeto de desconto", async () => {
      const dto = plainToInstance(CriarVendaPdvDto, payloadValido({ descontoVenda: { tipo: "valor", valor: -5 } }));
      const erros = await validate(dto);
      expect(erros.some((erro) => erro.property === "descontoVenda")).toBe(true);
    });
  });

  describe("desconto por item — Etapa 10.3", () => {
    it("aceita item sem desconto", async () => {
      const dto = plainToInstance(CriarVendaPdvDto, payloadValido());
      expect(await validate(dto)).toHaveLength(0);
    });

    it("aceita item com desconto em valor", async () => {
      const dto = plainToInstance(
        CriarVendaPdvDto,
        payloadValido({ itens: [{ produtoId: "a", varianteId: "b", tamanhoId: "c", quantidade: 1, desconto: { tipo: "valor", valor: 10 } }] }),
      );
      expect(await validate(dto)).toHaveLength(0);
    });

    it("aceita item com desconto em percentual", async () => {
      const dto = plainToInstance(
        CriarVendaPdvDto,
        payloadValido({ itens: [{ produtoId: "a", varianteId: "b", tamanhoId: "c", quantidade: 1, desconto: { tipo: "percentual", valor: 10 } }] }),
      );
      expect(await validate(dto)).toHaveLength(0);
    });

    it("rejeita desconto de item com percentual negativo", async () => {
      const dto = plainToInstance(
        CriarVendaPdvDto,
        payloadValido({ itens: [{ produtoId: "a", varianteId: "b", tamanhoId: "c", quantidade: 1, desconto: { tipo: "percentual", valor: -1 } }] }),
      );
      const erros = await validate(dto, { validationError: { target: false } });
      expect(erros.some((erro) => erro.property === "itens")).toBe(true);
    });
  });
});
