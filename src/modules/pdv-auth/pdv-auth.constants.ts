/**
 * Constantes do MARIELA PDV — deliberadamente duplicadas em vez de importadas
 * de `modules/auth/auth.constants.ts`: `Vendedor` não é `Usuario` (ver
 * `common/types/role.type.ts`), e este módulo não deve ter nenhuma aresta de
 * dependência para o módulo Auth do Backoffice — nem para reaproveitar uma
 * constante — para que os dois domínios de identidade fiquem fisicamente
 * desacoplados (uma mudança em um nunca arrisca vazar para o outro).
 */

/** Tamanho do refresh token opaco antes de base64url — 32 bytes = 256 bits de entropia (mesmo valor do ADMIN). */
export const REFRESH_TOKEN_BYTES = 32;

/** Janela e limite do throttle de login do PDV (ver `PdvAuthLoginThrottleService`) — mesmos valores do ADMIN, sem motivo de negócio para divergir. */
export const PDV_LOGIN_THROTTLE_JANELA_MS = 15 * 60 * 1000;
export const PDV_LOGIN_THROTTLE_MAX_TENTATIVAS = 5;

/**
 * Etapa 24 — rate limiting de `POST /pdv/auth/login` via `@nestjs/throttler`
 * (`PdvAuthController`) — mesmos valores e mesmo racional de
 * `AUTH_LOGIN_THROTTLE_LIMITE`/`AUTH_LOGIN_THROTTLE_TTL_MS` do módulo `auth`
 * (deliberadamente DUPLICADOS aqui, nunca importados de lá — ver o
 * comentário no topo deste arquivo sobre o desacoplamento entre os dois
 * domínios de identidade). 10 requisições / 10s por IP — a suíte de testes
 * HTTP deste endpoint já faz 5 chamadas reais hoje; a margem evita que um
 * novo cenário de teste comece a esbarrar no limite sem relação nenhuma com
 * o propósito dele.
 */
export const PDV_AUTH_LOGIN_THROTTLE_LIMITE = 10;
export const PDV_AUTH_LOGIN_THROTTLE_TTL_MS = 10_000;
