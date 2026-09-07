/**
 * Códigos de erro estáveis da API — contrato público, não deve depender de
 * mensagens internas do Mongoose/Express nem mudar entre versões.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  HTTP_ERROR: "HTTP_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
  // Auth — códigos específicos para o front distinguir cenários sem que a
  // mensagem (deliberadamente genérica em login/credenciais) precise mudar.
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  REFRESH_TOKEN_INVALID: "REFRESH_TOKEN_INVALID",
  REFRESH_TOKEN_REUSED: "REFRESH_TOKEN_REUSED",
  USER_INACTIVE: "USER_INACTIVE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
