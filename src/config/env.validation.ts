import { Transform, Type, plainToInstance, type TransformFnParams } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateIf, validateSync } from "class-validator";
import { LIMITES_TRANSPORTE_R2 } from "../modules/media/media.constants.js";
import { PROVEDORES_ENVIO_WHATSAPP } from "../modules/whatsapp/providers/meta/meta-cloud-api.constants.js";
import { lerOrigensCors, motivoOrigemCorsInvalida } from "./cors.config.js";

enum Ambiente {
  Development = "development",
  Test = "test",
  Production = "production",
}

/** Piso comum recomendado (OWASP) para uma chave de assinatura/HMAC — 32 caracteres ≈ 256 bits em um charset típico. Só é exigido em produção (ver `validarSegredosDeProducao`) para não quebrar segredos de desenvolvimento/teste mais curtos já em uso. */
const TAMANHO_MINIMO_SEGREDO_PRODUCAO = 32;

/**
 * Fase 22.8.9.2 (B-02) — o ÚNICO banco aceito em produção. Comparação exata (maiúsculas/minúsculas inclusive): um
 * `marieladb` ou `MarielaDB` seria outro banco no Atlas, vazio, e a API subiria "saudável" sem os dados reais.
 */
const BANCO_OFICIAL_PRODUCAO = "marielaDB";

/**
 * Fase 60.4.1 — variável numérica OPCIONAL: vazia (como em `.env.example`, `R2_MAX_ATTEMPTS=`) conta como
 * ausente (vale o padrão do projeto); qualquer outro texto vira número e passa pelas validações (texto inválido
 * vira `NaN` e é recusado).
 */
function vazioComoAusente({ value }: TransformFnParams): number | undefined {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return undefined;
  return Number(value);
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

  /**
   * Fase 48.1-B — exige um nome de banco explícito no path da URI (ex.:
   * `.../marielaDB?...`), não só o esquema. Sem isto, uma connection string
   * copiada direto do "Connect > Drivers" do Atlas (que por padrão vem SEM
   * banco no path) conecta com sucesso, mas o driver do MongoDB cai
   * silenciosamente no banco padrão "test" — nenhum erro, nenhum aviso,
   * só os dados aparecendo no banco errado. Mesma exigência que
   * `ops/backup/backup-mongo.ps1` já aplica a `MONGODB_BACKUP_URI` desde a
   * Fase 32, agora espelhada aqui para toda conexão da aplicação (API e
   * scripts, como `seed-admin.ts`, que reutilizam este mesmo `ConfigModule`
   * — nenhuma configuração paralela).
   */
  @IsString()
  @Matches(/^mongodb(\+srv)?:\/\/[^/]+\/[^/?]+/, {
    message:
      'MONGODB_URI deve incluir o nome do banco no path (ex.: "mongodb+srv://usuario:senha@host/NOME_DO_BANCO?..."). Sem ele, o driver do MongoDB conecta silenciosamente ao banco padrão "test".',
  })
  MONGODB_URI!: string;

  @IsString()
  @Matches(/\S/, { message: "JWT_ACCESS_SECRET não pode ser vazio ou conter somente espaços." })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @Matches(/\S/, { message: "JWT_REFRESH_SECRET não pode ser vazio ou conter somente espaços." })
  JWT_REFRESH_SECRET!: string;

  /**
   * Fase 22.8.7.2 — chave HMAC exclusiva do hash da `Idempotency-Key` da recuperação do refresh token. OPCIONAL:
   * ausente ou vazia desliga a recuperação (comportamento da Fase 22.8.7.1). Quando presente, é validada em
   * `validarSegredoRecuperacao` (tamanho mínimo e distinta dos segredos JWT) em QUALQUER ambiente — nunca há fallback.
   */
  @IsOptional()
  @IsString()
  REFRESH_IDEMPOTENCIA_HMAC_SECRET?: string;

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
   * Fase 22.8.9.10.4 — provedor do envio por template. Nome desconhecido impede o boot (erro de digitação nunca vira
   * "outro provedor" em silêncio); ausente/vazio = desativado. As variáveis `META_WHATSAPP_*` são OPCIONAIS e
   * validadas em tempo de execução (`lerConfiguracaoMeta`): incompletas ou malformadas só DESATIVAM o envio — nunca
   * impedem o boot da API nem ativam a Meta parcialmente. Nenhuma mensagem de erro inclui os valores.
   */
  @IsOptional()
  @IsIn([...PROVEDORES_ENVIO_WHATSAPP, ""], {
    message: `WHATSAPP_PROVEDOR_ENVIO deve ser ${PROVEDORES_ENVIO_WHATSAPP.map((p) => `"${p}"`).join(" ou ")} (ou vazia = desativado).`,
  })
  WHATSAPP_PROVEDOR_ENVIO?: string;

  @IsOptional()
  @IsString()
  META_WHATSAPP_GRAPH_API_VERSION?: string;

  @IsOptional()
  @IsString()
  META_WHATSAPP_PHONE_NUMBER_ID?: string;

  @IsOptional()
  @IsString()
  META_WHATSAPP_BUSINESS_ACCOUNT_ID?: string;

  @IsOptional()
  @IsString()
  META_WHATSAPP_ACCESS_TOKEN?: string;

  @IsOptional()
  @IsString()
  META_WHATSAPP_TIMEOUT_MS?: string;

  /**
   * Fase 22.8.9.10.5 — webhook da Cloud API. Opcionais e validados em tempo de execução
   * (`lerConfiguracaoWebhookMeta`): ausentes ou malformados só DESATIVAM o webhook, nunca impedem o boot.
   */
  @IsOptional()
  @IsString()
  META_WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string;

  @IsOptional()
  @IsString()
  META_WHATSAPP_APP_SECRET?: string;

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
   * Fase 60.4.1 — transporte das chamadas de rede ao R2 (padrões em `TRANSPORTE_R2_PADRAO`). Opcionais; quando
   * informadas precisam ser inteiras e dentro de faixas que evitam tanto um timeout que corta toda chamada quanto
   * uma espera que prende a requisição HTTP por minutos.
   */
  @IsOptional()
  @Transform(vazioComoAusente)
  @IsInt({ message: "R2_CONNECTION_TIMEOUT_MS deve ser um número inteiro de milissegundos." })
  @Min(LIMITES_TRANSPORTE_R2.R2_CONNECTION_TIMEOUT_MS.minimo)
  @Max(LIMITES_TRANSPORTE_R2.R2_CONNECTION_TIMEOUT_MS.maximo)
  R2_CONNECTION_TIMEOUT_MS?: number;

  @IsOptional()
  @Transform(vazioComoAusente)
  @IsInt({ message: "R2_REQUEST_TIMEOUT_MS deve ser um número inteiro de milissegundos." })
  @Min(LIMITES_TRANSPORTE_R2.R2_REQUEST_TIMEOUT_MS.minimo)
  @Max(LIMITES_TRANSPORTE_R2.R2_REQUEST_TIMEOUT_MS.maximo)
  R2_REQUEST_TIMEOUT_MS?: number;

  @IsOptional()
  @Transform(vazioComoAusente)
  @IsInt({ message: "R2_MAX_ATTEMPTS deve ser um número inteiro." })
  @Min(LIMITES_TRANSPORTE_R2.R2_MAX_ATTEMPTS.minimo)
  @Max(LIMITES_TRANSPORTE_R2.R2_MAX_ATTEMPTS.maximo)
  R2_MAX_ATTEMPTS?: number;

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

  /**
   * Fase 60.4.3.4.18 — reconciliação automática de estoque em cancelamentos (`ReconciliacaoEstoqueWorker`). Todas
   * opcionais (vazias = padrão de `RECONCILIACAO_ESTOQUE_PADRAO`). O worker só liga com
   * `RECONCILIACAO_ESTOQUE_HABILITADA=true` explícito (Fase 60.4.3.4.18.3 — desligado por padrão, inclusive em
   * produção). Faixas impedem um laço agressivo (intervalo
   * mínimo de 5 s, espera mínima de 1 s) ou um ciclo que carregue a coleção inteira.
   */
  @IsOptional()
  @IsIn(["true", "false", ""], { message: "RECONCILIACAO_ESTOQUE_HABILITADA deve ser \"true\", \"false\" ou vazia (padrão)." })
  RECONCILIACAO_ESTOQUE_HABILITADA?: string;

  @IsOptional()
  @Transform(vazioComoAusente)
  @IsInt({ message: "RECONCILIACAO_ESTOQUE_INTERVALO_MS deve ser um número inteiro de milissegundos." })
  @Min(5_000)
  @Max(86_400_000)
  RECONCILIACAO_ESTOQUE_INTERVALO_MS?: number;

  @IsOptional()
  @Transform(vazioComoAusente)
  @IsInt({ message: "RECONCILIACAO_ESTOQUE_LOTE deve ser um número inteiro." })
  @Min(1)
  @Max(500)
  RECONCILIACAO_ESTOQUE_LOTE?: number;

  @IsOptional()
  @Transform(vazioComoAusente)
  @IsInt({ message: "RECONCILIACAO_ESTOQUE_MAX_ITENS_POR_CICLO deve ser um número inteiro." })
  @Min(1)
  @Max(5_000)
  RECONCILIACAO_ESTOQUE_MAX_ITENS_POR_CICLO?: number;

  @IsOptional()
  @Transform(vazioComoAusente)
  @IsInt({ message: "RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS deve ser um número inteiro." })
  @Min(1)
  @Max(100)
  RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS?: number;

  @IsOptional()
  @Transform(vazioComoAusente)
  @IsInt({ message: "RECONCILIACAO_ESTOQUE_BACKOFF_BASE_MS deve ser um número inteiro de milissegundos." })
  @Min(1_000)
  @Max(86_400_000)
  RECONCILIACAO_ESTOQUE_BACKOFF_BASE_MS?: number;

  @IsOptional()
  @Transform(vazioComoAusente)
  @IsInt({ message: "RECONCILIACAO_ESTOQUE_BACKOFF_MAX_MS deve ser um número inteiro de milissegundos." })
  @Min(1_000)
  @Max(604_800_000)
  RECONCILIACAO_ESTOQUE_BACKOFF_MAX_MS?: number;
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

/**
 * Fase 22.8.9.2 (B-02) — nome do banco no path da URI: tudo entre a barra após o host e a query string, decodificado
 * como o driver faz (`%xx`). `null` quando não há path ou a decodificação falha (tratado como banco inválido).
 */
function bancoDaUriMongo(uri: string): string | null {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?#]*)/.exec(uri);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Fase 22.8.9.2 (B-02) — SÓ em produção: `MONGODB_URI` precisa apontar exatamente para `BANCO_OFICIAL_PRODUCAO`.
 * Sem banco, `test` ou qualquer outro nome = a API não sobe. Roda dentro de `validateEnv`, isto é, no
 * `ConfigModule.forRoot` — antes de o `DatabaseModule` criar a conexão. Não há variável/parâmetro de exceção: fora de
 * produção (desenvolvimento e testes com bancos descartáveis) nada muda. A mensagem nunca inclui a URI nem o nome
 * recebido (a URI carrega credenciais).
 */
function validarBancoDeProducao(env: EnvironmentVariables): void {
  if (bancoDaUriMongo(env.MONGODB_URI) !== BANCO_OFICIAL_PRODUCAO) {
    throw new Error(
      `Configuração de ambiente inválida: em produção (NODE_ENV=production), MONGODB_URI deve apontar para o banco "${BANCO_OFICIAL_PRODUCAO}" (nome exato no path da URI). A API não foi iniciada e nenhuma conexão com o MongoDB foi aberta.`,
    );
  }
}

/**
 * Fase 22.8.7.2 — o segredo da recuperação, QUANDO presente, precisa ser forte em qualquer ambiente (o mecanismo é
 * novo: não há segredo curto legado a preservar) e INDEPENDENTE de todos os segredos JWT — reaproveitar um deles
 * acoplaria o vazamento de um ao outro. Ausente/vazio = mecanismo desligado (não é erro). Nunca inclui o valor na
 * mensagem.
 */
function validarSegredoRecuperacao(env: EnvironmentVariables): void {
  // Fase 22.8.7.5 (F6) — UM valor normalizado (`trim`) para tudo: ausente/vazio, tamanho e independência. É o mesmo
  // valor que `configuration.ts` entrega como chave HMAC. Vazio depois do `trim` (inclusive só espaços) = desligado.
  const segredo = env.REFRESH_IDEMPOTENCIA_HMAC_SECRET?.trim() ?? "";
  if (segredo === "") return;
  if (segredo.length < TAMANHO_MINIMO_SEGREDO_PRODUCAO) {
    throw new Error(
      `Configuração de ambiente inválida: REFRESH_IDEMPOTENCIA_HMAC_SECRET, quando definida, deve ter pelo menos ${TAMANHO_MINIMO_SEGREDO_PRODUCAO} caracteres (sem contar espaços nas pontas).`,
    );
  }
  // Os segredos JWT também são comparados normalizados: espaços nas pontas não tornam dois segredos "diferentes".
  const repetido = CAMPOS_SEGREDO_JWT.filter((campo) => (env[campo] as string).trim() === segredo);
  if (repetido.length > 0) {
    throw new Error(
      `Configuração de ambiente inválida: REFRESH_IDEMPOTENCIA_HMAC_SECRET não pode reutilizar o valor de ${repetido.join(", ")}.`,
    );
  }
}

/**
 * Fase 58 — cada origem de `CORS_ORIGINS` precisa ser exata (ver
 * `motivoOrigemCorsInvalida`): um curinga, um caminho ou uma barra final nunca
 * são aceitos em silêncio (o `cors` simplesmente nunca casaria a origem, ou
 * abriria mais do que o pretendido). Vazio continua válido: CORS desligado.
 */
function validarOrigensCors(env: EnvironmentVariables): void {
  const invalidas = lerOrigensCors(env.CORS_ORIGINS).flatMap((origem) => {
    const motivo = motivoOrigemCorsInvalida(origem);
    return motivo ? [`"${origem}" (${motivo})`] : [];
  });
  if (invalidas.length > 0) {
    throw new Error(`Configuração de ambiente inválida: CORS_ORIGINS contém origens inválidas: ${invalidas.join(", ")}.`);
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

  validarOrigensCors(validado);
  validarSegredoRecuperacao(validado);

  if (validado.NODE_ENV === Ambiente.Production) {
    validarBancoDeProducao(validado);
    validarSegredosDeProducao(validado);
  }

  return validado;
}
