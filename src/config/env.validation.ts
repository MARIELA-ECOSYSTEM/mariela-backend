import { Type, plainToInstance } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateIf, validateSync } from "class-validator";

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

  /**
   * Etapa Pré-22 — WhatsApp via Evolution API/Baileys. Deliberadamente
   * OPCIONAIS (nenhum `@IsNotEmpty`/obrigatoriedade): ausentes, a integração
   * fica desabilitada (`WhatsappService` responde `WHATSAPP_NOT_CONFIGURED`)
   * em vez de impedir o boot da API — mesmo racional de outras etapas ainda
   * não ativadas neste ambiente (dev/test nunca precisam da Evolution rodando).
   */
  @IsOptional()
  @IsString()
  WHATSAPP_OWNER_PHONE = "";

  @IsOptional()
  @IsString()
  EVOLUTION_API_URL = "";

  @IsOptional()
  @IsString()
  EVOLUTION_API_KEY = "";

  @IsOptional()
  @IsString()
  EVOLUTION_INSTANCE_NAME = "mariela-whatsapp";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  EVOLUTION_TIMEOUT_MS = 10000;

  /**
   * Fase 40 — storage de mídia (Cloudflare R2). Deliberadamente OPCIONAIS,
   * como o WhatsApp: ausentes, o upload responde `STORAGE_NOT_CONFIGURED` em
   * vez de impedir o boot. Só o formato de `R2_PUBLIC_BASE_URL` é validado
   * (quando informada), porque ela é montada em URLs devolvidas ao cliente.
   */
  @IsOptional()
  @IsString()
  R2_ACCOUNT_ID = "";

  @IsOptional()
  @IsString()
  R2_ACCESS_KEY_ID = "";

  @IsOptional()
  @IsString()
  R2_SECRET_ACCESS_KEY = "";

  @IsOptional()
  @IsString()
  R2_BUCKET_NAME = "";

  @IsOptional()
  @IsString()
  @ValidateIf((env: EnvironmentVariables) => Boolean(env.R2_PUBLIC_BASE_URL?.trim()))
  @Matches(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/, {
    message: "R2_PUBLIC_BASE_URL deve ser uma URL http(s) sem query string (ex.: https://midia.exemplo.com).",
  })
  R2_PUBLIC_BASE_URL = "";

  /**
   * Etapa 24 — rate limiting GLOBAL/moderado (`@nestjs/throttler`, aplicado a
   * TODAS as rotas via `APP_GUARD`), configurável por ambiente porque é o
   * único dos três níveis de throttle (global/login/WhatsApp) que faz sentido
   * ajustar sem redeploy, conforme o tráfego real observado em produção. Os
   * limites de login/WhatsApp permanecem constantes fixas (mesmo padrão já
   * usado por `LOGIN_THROTTLE_MAX_TENTATIVAS`), pois são valores de segurança
   * calibrados deliberadamente, não parâmetros operacionais.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  RATE_LIMIT_GLOBAL_LIMIT = 300;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  RATE_LIMIT_GLOBAL_TTL_MS = 60000;
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
