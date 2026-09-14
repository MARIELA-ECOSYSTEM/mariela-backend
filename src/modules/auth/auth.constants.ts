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

/**
 * Etapa 24 — rate limiting de `POST /auth/login` via `@nestjs/throttler`
 * (`AuthController`), camada DIFERENTE e complementar ao `LoginThrottleService`
 * acima: aquele conta só FALHAS, por IP+e-mail (protege UMA conta contra força
 * bruta); este conta TODA requisição (sucesso ou falha), só por IP (protege
 * contra um script disparando tentativas rápidas contra MUITAS contas
 * diferentes a partir da mesma origem, algo que o limite por-e-mail não
 * alcança). 10 requisições / 10s por IP: folgado o bastante para uma pessoa
 * errar a senha algumas vezes seguidas sem ser bloqueada (inclusive a suíte
 * de testes HTTP deste endpoint, que hoje faz 2 chamadas reais — mantém
 * margem confortável para cenários futuros), apertado o suficiente para
 * limitar um script a no máximo 60 tentativas/min por IP. Valor fixo (não
 * configurável por ambiente) de propósito — é um parâmetro de segurança
 * calibrado, não operacional (mesmo racional de `LOGIN_THROTTLE_MAX_TENTATIVAS`
 * acima).
 */
export const AUTH_LOGIN_THROTTLE_LIMITE = 10;
export const AUTH_LOGIN_THROTTLE_TTL_MS = 10_000;
