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
  // WhatsApp/Evolution API (Etapa Pré-22) — erros externos normalizados para
  // que o frontend nunca precise conhecer o vocabulário da Evolution API.
  EVOLUTION_UNAVAILABLE: "EVOLUTION_UNAVAILABLE",
  WHATSAPP_NOT_CONFIGURED: "WHATSAPP_NOT_CONFIGURED",
  WHATSAPP_NOT_CONNECTED: "WHATSAPP_NOT_CONNECTED",
  WHATSAPP_INVALID_NUMBER: "WHATSAPP_INVALID_NUMBER",
  WHATSAPP_SEND_FAILED: "WHATSAPP_SEND_FAILED",
  WHATSAPP_TIMEOUT: "WHATSAPP_TIMEOUT",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
