import { TRANSPORTE_R2_PADRAO } from "../modules/media/media.constants.js";
import {
  META_GRAPH_API_VERSION_PADRAO,
  META_TIMEOUT_MS_PADRAO,
  PROVEDOR_ENVIO_PADRAO,
} from "../modules/whatsapp/providers/meta/meta-cloud-api.constants.js";
import { RECONCILIACAO_ESTOQUE_PADRAO } from "../modules/vendas/vendas.constants.js";
import { lerOrigensCors } from "./cors.config.js";

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
  /**
   * Fase 22.8.9.10.4 — provedor do envio por TEMPLATE. Só `"meta-cloud-api"` explícito seleciona a Cloud API da Meta;
   * ausente/vazio = `"desativado"` (padrão em QUALQUER ambiente). Mesmo selecionada, a Meta só é usada com a
   * configuração `meta` completa e válida (`lerConfiguracaoMeta`); senão o envio fica desativado.
   * Opcional no TIPO (como `storage.transporte`): contextos que montam só a Evolution não precisam dele; ausente =
   * desativado. `configuration()` sempre o preenche.
   */
  provedorEnvio?: string;
  meta?: MetaWhatsappConfig;
  /**
   * Fase 22.8.9.10.5 — webhook da Cloud API. `verifyToken` (verificação GET) e `appSecret` (HMAC do POST) são
   * credenciais: nunca logados, devolvidos nem incluídos em erro. Incompletos = webhook desativado. Opcional no tipo
   * pelo mesmo motivo de `meta`.
   */
  metaWebhook?: MetaWebhookWhatsappConfig;
}

export interface MetaWebhookWhatsappConfig {
  verifyToken: string;
  appSecret: string;
}

/** Fase 22.8.9.10.4 — Cloud API da Meta. `accessToken` é credencial: nunca logado, devolvido nem incluído em erro. */
export interface MetaWhatsappConfig {
  graphApiVersion: string;
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  timeoutMs: number;
}

/**
 * Fase 40 — storage de mídia (imagens/vídeos do catálogo) no Cloudflare R2
 * (API compatível com S3). `secretAccessKey`/`accessKeyId` são credenciais:
 * nunca lidas fora deste namespace, nunca logadas nem devolvidas por API.
 * Tudo opcional: qualquer variável ausente só desabilita o upload
 * (`MediaService` responde `STORAGE_NOT_CONFIGURED`), nunca impede o boot.
 */
export interface StorageConfig {
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
    /** Base pública do bucket (domínio próprio ou `pub-….r2.dev`), sem barra final. */
    publicBaseUrl: string;
  };
  /**
   * Fase 60.4.1 — timeouts e tentativas das chamadas de rede ao R2. Opcional de propósito: contextos que montam
   * só `r2` (ex.: o comando local de limpeza) usam os padrões de `TRANSPORTE_R2_PADRAO`.
   */
  transporte?: {
    /** Tempo máximo para estabelecer a conexão (ms). */
    timeoutConexaoMs: number;
    /** Inatividade máxima do socket por tentativa (ms). */
    timeoutRequisicaoMs: number;
    /** Tentativas por operação, incluindo a primeira (só falhas transitórias são repetidas). */
    maxTentativas: number;
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

/**
 * Fase 60.4.3.4.18 — reconciliação automática de estoque em cancelamentos/devoluções (`ReconciliacaoEstoqueWorker`).
 * Padrões em `RECONCILIACAO_ESTOQUE_PADRAO` (`vendas.constants.ts`).
 */
export interface ReconciliacaoEstoqueConfig {
  habilitada: boolean;
  intervaloMs: number;
  /** Máximo de vendas lidas por ciclo. */
  loteVendas: number;
  /** Máximo de linhas tentadas por ciclo (somadas todas as vendas do lote). */
  maxItensPorCiclo: number;
  /** Ao atingir este número de tentativas falhas, a linha vira `requer_intervencao` (o worker para de tentar). */
  maxTentativas: number;
  esperaBaseMs: number;
  esperaMaximaMs: number;
}

/**
 * Fase 22.8.7.2 — recuperação idempotente da rotação do refresh token administrativo. `segredoHmac` é a chave HMAC
 * EXCLUSIVA do hash da `Idempotency-Key` (nunca um segredo JWT), já normalizada com `trim` (Fase 22.8.7.5). `null`
 * (variável ausente ou vazia após `trim`) = mecanismo
 * DESLIGADO: nenhuma rotação grava material de recuperação e uma chave apresentada com R1 já rotacionado é tratada
 * como reutilização — exatamente o comportamento da Fase 22.8.7.1. Valor presente mas inválido impede o boot
 * (`validateEnv`).
 */
export interface RecuperacaoRefreshConfig {
  segredoHmac: string | null;
}

export interface Configuration {
  app: AppConfig;
  database: DatabaseConfig;
  jwt: JwtConfig;
  recuperacaoRefresh: RecuperacaoRefreshConfig;
  pdvJwt: PdvJwtConfig;
  cors: CorsConfig;
  whatsapp: WhatsappConfig;
  storage: StorageConfig;
  rateLimit: RateLimitConfig;
  reconciliacaoEstoque: ReconciliacaoEstoqueConfig;
}

export default (): Configuration => {
  const nodeEnv = process.env["NODE_ENV"] ?? "development";
  const swaggerEnabledRaw = process.env["SWAGGER_ENABLED"];
  const reconciliacaoHabilitadaRaw = process.env["RECONCILIACAO_ESTOQUE_HABILITADA"];

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
    recuperacaoRefresh: {
      // Fase 22.8.7.5 (F6) — mesmo valor normalizado validado em `validarSegredoRecuperacao`; vazio após `trim` = desligado.
      segredoHmac: process.env["REFRESH_IDEMPOTENCIA_HMAC_SECRET"]?.trim() || null,
    },
    pdvJwt: {
      accessSecret: process.env["PDV_JWT_ACCESS_SECRET"] ?? "",
      refreshSecret: process.env["PDV_JWT_REFRESH_SECRET"] ?? "",
      accessExpiresIn: process.env["PDV_JWT_ACCESS_EXPIRES_IN"] ?? "30m",
      refreshExpiresIn: process.env["PDV_JWT_REFRESH_EXPIRES_IN"] ?? "12h",
    },
    cors: {
      origins: lerOrigensCors(process.env["CORS_ORIGINS"]),
    },
    whatsapp: {
      ownerPhone: process.env["WHATSAPP_OWNER_PHONE"] ?? "",
      evolution: {
        apiUrl: process.env["EVOLUTION_API_URL"] ?? "",
        apiKey: process.env["EVOLUTION_API_KEY"] ?? "",
        instanceName: process.env["EVOLUTION_INSTANCE_NAME"] ?? "mariela-whatsapp",
        timeoutMs: Number(process.env["EVOLUTION_TIMEOUT_MS"] ?? 10000),
      },
      provedorEnvio: (process.env["WHATSAPP_PROVEDOR_ENVIO"] ?? "").trim() || PROVEDOR_ENVIO_PADRAO,
      meta: {
        graphApiVersion: (process.env["META_WHATSAPP_GRAPH_API_VERSION"] ?? "").trim() || META_GRAPH_API_VERSION_PADRAO,
        phoneNumberId: (process.env["META_WHATSAPP_PHONE_NUMBER_ID"] ?? "").trim(),
        businessAccountId: (process.env["META_WHATSAPP_BUSINESS_ACCOUNT_ID"] ?? "").trim(),
        accessToken: (process.env["META_WHATSAPP_ACCESS_TOKEN"] ?? "").trim(),
        timeoutMs: Number(process.env["META_WHATSAPP_TIMEOUT_MS"] || META_TIMEOUT_MS_PADRAO),
      },
      metaWebhook: {
        verifyToken: (process.env["META_WHATSAPP_WEBHOOK_VERIFY_TOKEN"] ?? "").trim(),
        appSecret: (process.env["META_WHATSAPP_APP_SECRET"] ?? "").trim(),
      },
    },
    storage: {
      r2: {
        accountId: (process.env["R2_ACCOUNT_ID"] ?? "").trim(),
        accessKeyId: (process.env["R2_ACCESS_KEY_ID"] ?? "").trim(),
        secretAccessKey: (process.env["R2_SECRET_ACCESS_KEY"] ?? "").trim(),
        bucketName: (process.env["R2_BUCKET_NAME"] ?? "").trim(),
        publicBaseUrl: (process.env["R2_PUBLIC_BASE_URL"] ?? "").trim().replace(/\/+$/, ""),
      },
      transporte: {
        timeoutConexaoMs: Number(process.env["R2_CONNECTION_TIMEOUT_MS"] || TRANSPORTE_R2_PADRAO.timeoutConexaoMs),
        timeoutRequisicaoMs: Number(process.env["R2_REQUEST_TIMEOUT_MS"] || TRANSPORTE_R2_PADRAO.timeoutRequisicaoMs),
        maxTentativas: Number(process.env["R2_MAX_ATTEMPTS"] || TRANSPORTE_R2_PADRAO.maxTentativas),
      },
    },
    rateLimit: {
      globalLimit: Number(process.env["RATE_LIMIT_GLOBAL_LIMIT"] ?? 300),
      globalTtlMs: Number(process.env["RATE_LIMIT_GLOBAL_TTL_MS"] ?? 60000),
    },
    reconciliacaoEstoque: {
      // Fase 60.4.3.4.18.3 — DESLIGADO por padrão em QUALQUER ambiente (inclusive produção): só `"true"` explícito liga.
      habilitada: reconciliacaoHabilitadaRaw?.trim() === "true",
      intervaloMs: Number(process.env["RECONCILIACAO_ESTOQUE_INTERVALO_MS"] || RECONCILIACAO_ESTOQUE_PADRAO.intervaloMs),
      loteVendas: Number(process.env["RECONCILIACAO_ESTOQUE_LOTE"] || RECONCILIACAO_ESTOQUE_PADRAO.loteVendas),
      maxItensPorCiclo: Number(process.env["RECONCILIACAO_ESTOQUE_MAX_ITENS_POR_CICLO"] || RECONCILIACAO_ESTOQUE_PADRAO.maxItensPorCiclo),
      maxTentativas: Number(process.env["RECONCILIACAO_ESTOQUE_MAX_TENTATIVAS"] || RECONCILIACAO_ESTOQUE_PADRAO.maxTentativas),
      esperaBaseMs: Number(process.env["RECONCILIACAO_ESTOQUE_BACKOFF_BASE_MS"] || RECONCILIACAO_ESTOQUE_PADRAO.esperaBaseMs),
      esperaMaximaMs: Number(process.env["RECONCILIACAO_ESTOQUE_BACKOFF_MAX_MS"] || RECONCILIACAO_ESTOQUE_PADRAO.esperaMaximaMs),
    },
  };
};
