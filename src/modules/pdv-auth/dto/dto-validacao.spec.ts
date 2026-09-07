import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LoginPdvDto } from "./login-pdv.dto.js";
import { RefreshPdvDto } from "./refresh-pdv.dto.js";

describe("LoginPdvDto", () => {
  it("aceita código e senha informados", async () => {
    const dto = plainToInstance(LoginPdvDto, { codigo: "VEN-0001", senha: "123456" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita código ausente", async () => {
    const dto = plainToInstance(LoginPdvDto, { senha: "123456" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "codigo")).toBe(true);
  });

  it("rejeita senha ausente", async () => {
    const dto = plainToInstance(LoginPdvDto, { codigo: "VEN-0001" });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "senha")).toBe(true);
  });

  it("rejeita payload totalmente vazio", async () => {
    const dto = plainToInstance(LoginPdvDto, {});
    const erros = await validate(dto);
    expect(erros.length).toBeGreaterThanOrEqual(2);
  });
});

describe("RefreshPdvDto", () => {
  it("aceita refreshToken informado", async () => {
    const dto = plainToInstance(RefreshPdvDto, { refreshToken: "abc123" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
  });

  it("rejeita refreshToken ausente", async () => {
    const dto = plainToInstance(RefreshPdvDto, {});
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "refreshToken")).toBe(true);
  });
});
