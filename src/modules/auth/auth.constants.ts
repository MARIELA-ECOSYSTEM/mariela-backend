export const CHAVE_SEQUENCIA_USUARIO = "usuario";
export const PREFIXO_CODIGO_USUARIO = "USR";
export const DIGITOS_CODIGO_USUARIO = 4;

/** Parâmetros do Argon2id (via `Bun.password`, nativo — ver decisão no relatório). */
export const ARGON2_MEMORY_COST = 19_456; // ~19 MiB, recomendação OWASP para argon2id
export const ARGON2_TIME_COST = 2;

/** Tamanho do refresh token opaco antes de base64url — 32 bytes = 256 bits de entropia. */
export const REFRESH_TOKEN_BYTES = 32;

/** Janela e limite do throttle de login local (ver `LoginThrottleService`). */
export const LOGIN_THROTTLE_JANELA_MS = 15 * 60 * 1000;
export const LOGIN_THROTTLE_MAX_TENTATIVAS = 5;
