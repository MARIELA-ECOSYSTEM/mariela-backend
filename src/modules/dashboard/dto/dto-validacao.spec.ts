import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ResumoDashboardQueryDto } from "./resumo-dashboard-query.dto.js";

describe("ResumoDashboardQueryDto", () => {
  it("aceita payload vazio (mes é opcional)", async () => {
    const dto = plainToInstance(ResumoDashboardQueryDto, {});
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.mes).toBeUndefined();
  });

  it("aceita mes no formato YYYY-MM", async () => {
    const dto = plainToInstance(ResumoDashboardQueryDto, { mes: "2026-08" });
    const erros = await validate(dto);
    expect(erros).toHaveLength(0);
    expect(dto.mes).toBe("2026-08");
  });

  it("rejeita mes que não é string", async () => {
    const dto = plainToInstance(ResumoDashboardQueryDto, { mes: 20268 });
    const erros = await validate(dto);
    expect(erros.some((erro) => erro.property === "mes")).toBe(true);
  });
});
