import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { PdvAuthenticatedRequest, VendedorPublicoPdv } from "../pdv-auth.types.js";

/**
 * Extrai o vendedor autenticado (`request.vendedor`), populado por
 * `PdvJwtAuthGuard`. `@VendedorPdv()` devolve a identidade pública inteira;
 * `@VendedorPdv('id')` devolve só aquele campo. Só é válido em rotas
 * protegidas por `PdvJwtAuthGuard` — sem verificação adicional aqui (mesmo
 * padrão de `@CurrentUser()`, ADMIN).
 */
export const VendedorPdv = createParamDecorator(
  (campo: keyof VendedorPublicoPdv | undefined, ctx: ExecutionContext): unknown => {
    const request = ctx.switchToHttp().getRequest<PdvAuthenticatedRequest>();
    return campo ? request.vendedor[campo] : request.vendedor;
  },
);
