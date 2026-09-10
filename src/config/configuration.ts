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

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  jwt: JwtConfig;
  pdvJwt: PdvJwtConfig;
  cors: CorsConfig;
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
  };
};
