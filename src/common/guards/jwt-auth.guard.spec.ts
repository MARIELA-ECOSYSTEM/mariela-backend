import { describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ApiException } from "../exceptions/api.exception.js";
import type { AuthenticatedRequest } from "../types/authenticated-request.interface.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";

const jwtService = new JwtService({ secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });
const guard = new JwtAuthGuard(jwtService);

function contextoComHeader(authorization?: string): ExecutionContext {
  const request = { headers: { authorization } } as unknown as AuthenticatedRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe("JwtAuthGuard", () => {
  it("aceita um token válido e popula request.user com o payload", async () => {
    const token = await jwtService.signAsync({ sub: "u1", codigo: "USR-0001", role: "ADMIN" });
    const ctx = contextoComHeader(`Bearer ${token}`);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    expect(request.user).toEqual(expect.objectContaining({ sub: "u1", codigo: "USR-0001", role: "ADMIN" }));
  });

  it("rejeita quando não há header Authorization", async () => {
    await expect(guard.canActivate(contextoComHeader(undefined))).rejects.toThrow(ApiException);
  });

  it("rejeita um header que não é 'Bearer <token>'", async () => {
    await expect(guard.canActivate(contextoComHeader("Basic algumacoisa"))).rejects.toThrow(ApiException);
  });

  it("rejeita um token expirado", async () => {
    const tokenExpirado = await jwtService.signAsync(
      { sub: "u1", codigo: "USR-0001", role: "ADMIN" },
      { expiresIn: "-10s" },
    );
    await expect(guard.canActivate(contextoComHeader(`Bearer ${tokenExpirado}`))).rejects.toThrow(ApiException);
  });

  it("rejeita um token assinado com outro segredo (assinatura inválida)", async () => {
    const outroServico = new JwtService({ secret: "segredo-diferente" });
    const token = await outroServico.signAsync({ sub: "u1", codigo: "USR-0001", role: "ADMIN" });
    await expect(guard.canActivate(contextoComHeader(`Bearer ${token}`))).rejects.toThrow(ApiException);
  });

  it("rejeita texto aleatório como token", async () => {
    await expect(guard.canActivate(contextoComHeader("Bearer isto-nao-e-um-jwt"))).rejects.toThrow(ApiException);
  });

  it("rejeita um payload com formato inválido (role desconhecida)", async () => {
    // Assinatura VÁLIDA, mas com um payload que este guard não reconhece —
    // simula, por exemplo, um token de um formato antigo/futuro de payload.
    const token = await jwtService.signAsync({ sub: "u1", codigo: "USR-0001", role: "PAPEL_INEXISTENTE" });
    await expect(guard.canActivate(contextoComHeader(`Bearer ${token}`))).rejects.toThrow(ApiException);
  });

  it("rejeita um payload sem 'sub'", async () => {
    const token = await jwtService.signAsync({ codigo: "USR-0001", role: "ADMIN" });
    await expect(guard.canActivate(contextoComHeader(`Bearer ${token}`))).rejects.toThrow(ApiException);
  });
});
