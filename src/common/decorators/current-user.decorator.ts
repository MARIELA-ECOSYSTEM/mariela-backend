import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest } from "../types/authenticated-request.interface.js";
import type { JwtPayload } from "../types/jwt-payload.interface.js";

/**
 * Extrai o usuário autenticado (`request.user`), populado pelo `JwtAuthGuard`.
 *
 * `@CurrentUser()` devolve o payload inteiro; `@CurrentUser('sub')` ou
 * `@CurrentUser('role')` devolvem só aquele campo — assim o controller nunca
 * precisa conhecer a forma inteira do JWT, só o dado que de fato usa.
 * Só é válido em rotas protegidas por `JwtAuthGuard` — não há verificação
 * adicional aqui.
 */
export const CurrentUser = createParamDecorator(
  (campo: keyof JwtPayload | undefined, ctx: ExecutionContext): unknown => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return campo ? request.user[campo] : request.user;
  },
);
