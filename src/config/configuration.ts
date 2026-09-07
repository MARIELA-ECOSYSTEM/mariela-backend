/**
 * Agrupa `process.env` (já validado por `validateEnv`) em namespaces coesos,
 * consumidos via `ConfigService.get('app.port')`, `ConfigService.get('jwt.accessSecret')` etc.
 * Nenhum outro módulo deve ler `process.env` diretamente.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  apiPrefix: string;
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

export interface CorsConfig {
  origins: string[];
}

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  jwt: JwtConfig;
  cors: CorsConfig;
}

export default (): Configuration => ({
  app: {
    nodeEnv: process.env["NODE_ENV"] ?? "development",
    port: Number(process.env["PORT"] ?? 3000),
    apiPrefix: process.env["API_PREFIX"] ?? "api/v1",
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
  cors: {
    origins: (process.env["CORS_ORIGINS"] ?? "")
      .split(",")
      .map((origem) => origem.trim())
      .filter(Boolean),
  },
});
