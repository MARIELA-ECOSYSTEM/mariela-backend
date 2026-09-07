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
