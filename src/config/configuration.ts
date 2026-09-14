/**
 * Agrupa `process.env` (já validado por `validateEnv`) em namespaces coesos,
 * consumidos via `ConfigService.get('app.port')`, `ConfigService.get('jwt.accessSecret')` etc.
 * Nenhum outro módulo deve ler `process.env` diretamente.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  apiPrefix: string;
  /** Etapa 18.23 — `/docs`+`/docs-json` (ver `main.ts`). Fora de produção, sempre `true`; em produção, só `true` com `SWAGGER_ENABLED=true` explícito. */
  swaggerEnabled: boolean;
}

export interface DatabaseConfig {
  uri: string;
}

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  accessExpiresIn: string;
  refreshExpiresIn: string;
}

/** Configuração do JWT do MARIELA PDV — segredos e expirações próprios, nunca compartilhados com `jwt` (ADMIN). */
export interface PdvJwtConfig {
  accessSecret: string;
  refreshSecret: string;
  accessExpiresIn: string;
  refreshExpiresIn: string;
}

export interface CorsConfig {
  origins: string[];
}

/**
 * Etapa Pré-22 — WhatsApp via Evolution API/Baileys. `ownerPhone` é o número
 * da loja (identidade da instância, não um segredo); `evolution.*` é
 * credencial/infraestrutura técnica. Nenhum dos dois é lido fora deste
 * namespace (ver `WhatsappModule`). Tudo opcional: ausência de
 * `evolution.apiUrl`/`apiKey` só desabilita a integração (`WhatsappService`
 * responde `WHATSAPP_NOT_CONFIGURED`), nunca impede o boot da API.
 */
export interface WhatsappConfig {
  ownerPhone: string;
  evolution: {
    apiUrl: string;
    apiKey: string;
    instanceName: string;
    timeoutMs: number;
  };
}

/**
 * Etapa 24 — só o piso GLOBAL/moderado (aplicado a toda rota via `APP_GUARD`)
 * é configurável por ambiente. Os limites específicos de login (`/auth/login`,
 * `/pdv/auth/login`) e de envio de WhatsApp são constantes de segurança fixas
 * (ver `auth.constants.ts`, `pdv-auth.constants.ts`, `whatsapp.constants.ts`),
 * não pertencem a este namespace.
 */
export interface RateLimitConfig {
  globalLimit: number;
  globalTtlMs: number;
}

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  jwt: JwtConfig;
  pdvJwt: PdvJwtConfig;
  cors: CorsConfig;
  whatsapp: WhatsappConfig;
  rateLimit: RateLimitConfig;
}

export default (): Configuration => {
  const nodeEnv = process.env["NODE_ENV"] ?? "development";
  const swaggerEnabledRaw = process.env["SWAGGER_ENABLED"];

  return {
    app: {
      nodeEnv,
      port: Number(process.env["PORT"] ?? 3000),
      apiPrefix: process.env["API_PREFIX"] ?? "api/v1",
      swaggerEnabled: nodeEnv !== "production" || swaggerEnabledRaw === "true",
    },
    database: {
      uri: process.env["MONGODB_URI"] ?? "",
    },
    jwt: {
      accessSecret: process.env["JWT_ACCESS_SECRET"] ?? "",
      refreshSecret: process.env["JWT_REFRESH_SECRET"] ?? "",
      accessExpiresIn: process.env["JWT_ACCESS_EXPIRES_IN"] ?? "15m",
      refreshExpiresIn: process.env["JWT_REFRESH_EXPIRES_IN"] ?? "7d",
    },
    pdvJwt: {
      accessSecret: process.env["PDV_JWT_ACCESS_SECRET"] ?? "",
      refreshSecret: process.env["PDV_JWT_REFRESH_SECRET"] ?? "",
      accessExpiresIn: process.env["PDV_JWT_ACCESS_EXPIRES_IN"] ?? "30m",
      refreshExpiresIn: process.env["PDV_JWT_REFRESH_EXPIRES_IN"] ?? "12h",
    },
    cors: {
      origins: (process.env["CORS_ORIGINS"] ?? "")
        .split(",")
        .map((origem) => origem.trim())
        .filter(Boolean),
    },
    whatsapp: {
      ownerPhone: process.env["WHATSAPP_OWNER_PHONE"] ?? "",
      evolution: {
        apiUrl: process.env["EVOLUTION_API_URL"] ?? "",
        apiKey: process.env["EVOLUTION_API_KEY"] ?? "",
        instanceName: process.env["EVOLUTION_INSTANCE_NAME"] ?? "mariela-whatsapp",
        timeoutMs: Number(process.env["EVOLUTION_TIMEOUT_MS"] ?? 10000),
      },
    },
    rateLimit: {
      globalLimit: Number(process.env["RATE_LIMIT_GLOBAL_LIMIT"] ?? 300),
      globalTtlMs: Number(process.env["RATE_LIMIT_GLOBAL_TTL_MS"] ?? 60000),
    },
  };
};
