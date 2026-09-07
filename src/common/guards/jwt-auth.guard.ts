import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ApiException } from "../exceptions/api.exception.js";
import { ROLES } from "../types/role.type.js";
import type { AuthenticatedRequest } from "../types/authenticated-request.interface.js";
import type { JwtPayload } from "../types/jwt-payload.interface.js";

/**
 * Guard de autenticação do Backoffice (ADMIN). Lê o access token do header
 * `Authorization: Bearer <token>`, valida a assinatura/expiração via
 * `JwtService` (configurado globalmente em `AppModule`) e popula `request.user`.
 *
 * Deliberadamente STATELESS — não consulta o MongoDB a cada requisição.
 * O access token tem vida curta (`JWT_ACCESS_EXPIRES_IN`, padrão 15min), então
 * um usuário desativado perde o acesso administrativo em, no máximo, esse
 * intervalo (a próxima renovação falha porque o refresh token é validado
 * contra o banco, e é ali que `ativo` é checado — ver `AuthService.refresh`).
 * Trocar por uma consulta a cada requisição adicionaria uma ida ao banco por
 * chamada só para cobrir uma janela de poucos minutos; não parece valer o
 * custo agora. Revisar se o TTL do access token crescer, ou com um cache
 * (Redis) quando ele existir.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extrairToken(request.headers.authorization);
    if (!token) throw ApiException.unauthorized("Token de acesso não informado.");

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw ApiException.unauthorized("Sessão expirada. Faça login novamente.");
    }

    if (!this.payloadValido(payload)) {
      throw ApiException.unauthorized("Sessão expirada. Faça login novamente.");
    }

    request.user = payload;
    return true;
  }

  /** Defesa contra um token assinado com um formato de payload diferente do atual (ex.: numa migração futura). */
  private payloadValido(payload: JwtPayload): boolean {
    return (
      typeof payload?.sub === "string" &&
      payload.sub.length > 0 &&
      typeof payload.codigo === "string" &&
      (ROLES as readonly string[]).includes(payload.role)
    );
  }

  private extrairToken(header: string | undefined): string | null {
    if (!header?.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length).trim() || null;
  }
}
