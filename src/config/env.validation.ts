import { Type, plainToInstance } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, validateSync } from "class-validator";

enum Ambiente {
  Development = "development",
  Test = "test",
  Production = "production",
}

/**
 * Contrato das variáveis de ambiente aceitas pela API.
 * Falha rápido (na inicialização) quando algo obrigatório está ausente ou mal formatado,
 * em vez de deixar o erro aparecer silenciosamente em tempo de execução.
 */
class EnvironmentVariables {
  @IsOptional()
  @IsIn(Object.values(Ambiente))
  NODE_ENV: Ambiente = Ambiente.Development;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/, {
    message: "API_PREFIX deve conter apenas segmentos em minúsculas (ex.: api/v1).",
  })
  API_PREFIX = "api/v1";

  @IsString()
  @Matches(/^mongodb(\+srv)?:\/\//, {
    message: "MONGODB_URI deve ser uma string de conexão válida do MongoDB.",
  })
  MONGODB_URI!: string;

  @IsString()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  JWT_REFRESH_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_EXPIRES_IN = "15m";

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN = "7d";

  @IsOptional()
  @IsString()
  CORS_ORIGINS = "";
}

/** Usado como `validate` do `ConfigModule.forRoot` — recebe `process.env` bruto. */
export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  // Conversão de tipos é sempre explícita (`@Type(() => Number)` em vez de
  // `enableImplicitConversion`): o transpilador do Bun não emite a metadata
  // `design:type` precisa que a conversão implícita do class-transformer exige
  // (ele reporta `Object` para qualquer propriedade primitiva), então contar
  // com ela faria toda validação numérica falhar silenciosamente em runtime Bun.
  const validado = plainToInstance(EnvironmentVariables, config);
  const erros = validateSync(validado, { skipMissingProperties: false });

  if (erros.length > 0) {
    const detalhes = erros
      .map((erro) => Object.values(erro.constraints ?? {}).join("; "))
      .join(" | ");
    throw new Error(`Configuração de ambiente inválida: ${detalhes}`);
  }

  return validado;
}
