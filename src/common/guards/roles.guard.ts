import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiException } from "../exceptions/api.exception.js";
import { ROLES_KEY } from "../decorators/roles.decorator.js";
import type { AuthenticatedRequest } from "../types/authenticated-request.interface.js";
import type { Role } from "../types/role.type.js";

/**
 * SÓ decide Authorization — assume que `JwtAuthGuard` já rodou antes e
 * populou `request.user`. Uma rota sem `@Roles(...)` é liberada para
 * qualquer usuário autenticado (o guard não é quem decide "precisa estar
 * logado", isso é o `JwtAuthGuard`).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const papeisExigidos = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!papeisExigidos || papeisExigidos.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!papeisExigidos.includes(request.user.role)) {
      throw ApiException.forbidden("Você não tem permissão para acessar este recurso.");
    }
    return true;
  }
}
