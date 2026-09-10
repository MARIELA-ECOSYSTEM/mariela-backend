import { Type, plainToInstance } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, validateSync } from "class-validator";

enum Ambiente {
  Development = "development",
  Test = "test",
  Production = "production",
}

/** Piso comum recomendado (OWASP) para uma chave de assinatura/HMAC — 32 caracteres ≈ 256 bits em um charset típico. Só é exigido em produção (ver `validarSegredosDeProducao`) para não quebrar segredos de desenvolvimento/teste mais curtos já em uso. */
const TAMANHO_MINIMO_SEGREDO_PRODUCAO = 32;

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
  @Matches(/\S/, { message: "JWT_ACCESS_SECRET não pode ser vazio ou conter somente espaços." })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @Matches(/\S/, { message: "JWT_REFRESH_SECRET não pode ser vazio ou conter somente espaços." })
  JWT_REFRESH_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_EXPIRES_IN = "15m";

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN = "7d";

  /**
   * Segredos e expirações do MARIELA PDV — deliberadamente SEPARADOS dos do
   * Backoffice (ver `pdv-auth.module.ts`): um vazamento de um segredo nunca
   * deve comprometer o outro domínio de identidade (Usuario × Vendedor).
   */
  @IsString()
  @Matches(/\S/, { message: "PDV_JWT_ACCESS_SECRET não pode ser vazio ou conter somente espaços." })
  PDV_JWT_ACCESS_SECRET!: string;

  @IsString()
  @Matches(/\S/, { message: "PDV_JWT_REFRESH_SECRET não pode ser vazio ou conter somente espaços." })
  PDV_JWT_REFRESH_SECRET!: string;

  @IsOptional()
  @IsString()
  PDV_JWT_ACCESS_EXPIRES_IN = "30m";

  @IsOptional()
  @IsString()
  PDV_JWT_REFRESH_EXPIRES_IN = "12h";

  @IsOptional()
  @IsString()
  CORS_ORIGINS = "";

  /**
   * Etapa 18.23 — opt-in explícito para expor `/docs`+`/docs-json` em
   * produção (por padrão, desligado nesse ambiente — ver
   * `configuration.ts#swaggerEnabled`). Fora de produção, sempre habilitado
   * independentemente deste valor.
   */
  @IsOptional()
  @IsIn(["true", "false"], { message: "SWAGGER_ENABLED deve ser \"true\" ou \"false\"." })
  SWAGGER_ENABLED?: string;
}

const CAMPOS_SEGREDO_JWT = [
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "PDV_JWT_ACCESS_SECRET",
  "PDV_JWT_REFRESH_SECRET",
] as const satisfies readonly (keyof EnvironmentVariables)[];

/**
 * Etapa 18.23 — exigência adicional, SÓ em produção: cada segredo JWT precisa
 * de pelo menos `TAMANHO_MINIMO_SEGREDO_PRODUCAO` caracteres. Os decorators de
 * classe já garantem "não vazio/não só espaços" em QUALQUER ambiente (ver
 * `@Matches(/\S/)` acima) — o piso de tamanho fica de fora deles de propósito
 * para não quebrar segredos de desenvolvimento/teste já em uso, mais curtos
 * que este piso mas ainda assim não-vazios.
 */
function validarSegredosDeProducao(env: EnvironmentVariables): void {
  const curtos = CAMPOS_SEGREDO_JWT.filter((campo) => (env[campo] as string).trim().length < TAMANHO_MINIMO_SEGREDO_PRODUCAO);
  if (curtos.length > 0) {
    throw new Error(
      `Configuração de ambiente inválida: em produção (NODE_ENV=production), os seguintes segredos devem ter pelo menos ${TAMANHO_MINIMO_SEGREDO_PRODUCAO} caracteres: ${curtos.join(", ")}.`,
    );
  }
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

  if (validado.NODE_ENV === Ambiente.Production) {
    validarSegredosDeProducao(validado);
  }

  return validado;
}
