import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { EnviarMensagemWhatsappDto } from "./enviar-mensagem-whatsapp.dto.js";

const ID_VALIDO = "65f1a2b3c4d5e6f7a8b9c0d1";

describe("EnviarMensagemWhatsappDto", () => {
  it("aceita um payload válido mínimo (tipo + id, sem mensagem)", async () => {
    const dto = plainToInstance(EnviarMensagemWhatsappDto, { tipo: "CLIENTE", id: ID_VALIDO });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("aceita mensagem opcional", async () => {
    const dto = plainToInstance(EnviarMensagemWhatsappDto, {
      tipo: "FORNECEDOR",
      id: ID_VALIDO,
      mensagem: "Olá!",
    });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("aceita os três tipos válidos", async () => {
    for (const tipo of ["CLIENTE", "FORNECEDOR", "VENDEDOR"]) {
      const dto = plainToInstance(EnviarMensagemWhatsappDto, { tipo, id: ID_VALIDO });
      const erros = await validate(dto);
      expect(erros).toHaveLength(0);
    }
  });

  it("rejeita tipo inválido", async () => {
    const dto = plainToInstance(EnviarMensagemWhatsappDto, { tipo: "ADMIN", id: ID_VALIDO });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "tipo")).toBe(true);
  });

  it("rejeita id ausente", async () => {
    const dto = plainToInstance(EnviarMensagemWhatsappDto, { tipo: "CLIENTE" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "id")).toBe(true);
  });

  it("rejeita id que não é um ObjectId válido", async () => {
    const dto = plainToInstance(EnviarMensagemWhatsappDto, { tipo: "CLIENTE", id: "não-é-um-id" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "id")).toBe(true);
  });

  it("rejeita mensagem acima de 1000 caracteres", async () => {
    const dto = plainToInstance(EnviarMensagemWhatsappDto, {
      tipo: "CLIENTE",
      id: ID_VALIDO,
      mensagem: "A".repeat(1001),
    });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "mensagem")).toBe(true);
  });

  it("nunca aceita um campo `telefone` como parte do próprio DTO (destinatário nunca vem do cliente da API)", () => {
    const dto = new EnviarMensagemWhatsappDto();
    expect("telefone" in dto).toBe(false);
  });
});
