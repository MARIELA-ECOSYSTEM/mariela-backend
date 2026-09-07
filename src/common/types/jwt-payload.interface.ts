import type { Role } from "./role.type.js";

/**
 * Claims do access token — mínimo necessário para autenticar e autorizar.
 * NUNCA inclua senha/hash, dados financeiros ou qualquer objeto grande aqui:
 * o payload do JWT é apenas base64 (legível por qualquer um que veja o token).
 *
 * `sub` é o id do usuário administrativo do Backoffice — vendedores (MARIELA
 * PDV) usam um fluxo de autenticação separado e nunca recebem um token válido
 * para este guard.
 */
export interface JwtPayload {
  sub: string;
  codigo: string;
  role: Role;
  iat?: number;
  exp?: number;
}
