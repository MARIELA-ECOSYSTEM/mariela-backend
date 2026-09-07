import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiException } from "../exceptions/api.exception.js";
import { RolesGuard } from "./roles.guard.js";

describe("RolesGuard", () => {
  it("permite quando a rota não exige nenhum papel específico", () => {
    const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user: { role: "ADMIN" } }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("permite ADMIN quando a rota exige ADMIN", () => {
    const reflector = { getAllAndOverride: () => ["ADMIN"] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user: { role: "ADMIN" } }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("bloqueia um usuário cujo papel não está na lista exigida", () => {
    const reflector = { getAllAndOverride: () => ["ADMIN"] } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    const ctx = {
      // Papel hipotético/futuro que ainda não existe no sistema — prova que o
      // mecanismo de autorização por papel realmente compara e bloqueia, e
      // não é apenas um `return true` disfarçado.
      switchToHttp: () => ({ getRequest: () => ({ user: { role: "OUTRO_PAPEL" } }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(ctx)).toThrow(ApiException);
  });
});
