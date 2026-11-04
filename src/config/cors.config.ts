import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface.js";

/**
 * Fase 58 — política de CORS da API, montada a partir de `CORS_ORIGINS`
 * (lista explícita; nunca `*`). Usada por `main.ts` e pelos testes de CORS,
 * para que o comportamento testado seja exatamente o aplicado no bootstrap.
 *
 * Origens dos frontends (verificadas na Fase 58):
 * - Backoffice em desenvolvimento: `http://localhost:8081` (`tauri.conf.json > build > devUrl`, Vite `port: 8081`);
 * - PDV em desenvolvimento: `http://localhost:8080` (`tauri.conf.json > build > devUrl`);
 * - Backoffice e PDV empacotados (Tauri 2, sem `useHttpsScheme`): `http://tauri.localhost`
 *   no Windows e `tauri://localhost` no macOS/Linux — mesma origem para os dois apps
 *   (a autorização é pelo token, nunca pela origem).
 */

/** Métodos usados pela API REST (controllers) — `OPTIONS` é o preflight. */
export const METODOS_CORS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * Cabeçalhos de requisição que os frontends enviam: `Content-Type` e
 * `Authorization` (Backoffice e PDV), `Idempotency-Key` (PDV) e `Accept`.
 */
export const CABECALHOS_CORS = ["Authorization", "Content-Type", "Accept", "Idempotency-Key"] as const;

/**
 * Origens aceitas em `CORS_ORIGINS`: `http(s)://host[:porta]` exato (sem
 * caminho, barra final, query, credenciais ou curinga) ou a origem do Tauri
 * empacotado em macOS/Linux (`tauri://localhost`).
 */
const ORIGEM_HTTP = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
const ORIGEM_TAURI = "tauri://localhost";

/** `null` = origem válida; texto = motivo da recusa. */
export function motivoOrigemCorsInvalida(origem: string): string | null {
  if (origem === "*" || origem.includes("*")) return "curinga (*) não é permitido";
  if (origem === ORIGEM_TAURI) return null;
  if (!ORIGEM_HTTP.test(origem)) return "use http(s)://host[:porta], sem caminho, barra final ou parâmetros";
  return null;
}

/** Lê `CORS_ORIGINS` (separada por vírgula), descartando espaços e itens vazios. */
export function lerOrigensCors(valor: string | undefined): string[] {
  return (valor ?? "")
    .split(",")
    .map((origem) => origem.trim())
    .filter(Boolean);
}

/**
 * Opções do `enableCors`. Sem origens configuradas, CORS fica DESLIGADO
 * (`origin: false`: nenhuma origem cruzada é aceita) — comportamento seguro.
 * `credentials: false`: nenhum frontend usa cookies (os tokens vão em
 * `Authorization`), então não há motivo para permitir credenciais cruzadas.
 */
export function montarOpcoesCors(origens: readonly string[]): CorsOptions {
  return {
    origin: origens.length > 0 ? [...origens] : false,
    methods: [...METODOS_CORS],
    allowedHeaders: [...CABECALHOS_CORS],
    credentials: false,
  };
}
