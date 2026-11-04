import type { ConfigService } from "@nestjs/config";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { Configuration } from "../../config/configuration.js";

const VARIAVEIS_R2: Record<"accountId" | "accessKeyId" | "secretAccessKey" | "bucketName" | "publicBaseUrl", string> = {
  accountId: "R2_ACCOUNT_ID",
  accessKeyId: "R2_ACCESS_KEY_ID",
  secretAccessKey: "R2_SECRET_ACCESS_KEY",
  bucketName: "R2_BUCKET_NAME",
  publicBaseUrl: "R2_PUBLIC_BASE_URL",
};

/**
 * Exige as 5 variáveis do R2 e devolve a base da URL pública. Compartilhado pelo endpoint antigo (Fase 40) e pela
 * galeria (Fase 60.1). A resposta cita só os NOMES das ausentes, nunca valores.
 */
export function exigirBaseUrlPublica(configService: ConfigService<Configuration>): string {
  const r2 = configService.get("storage", { infer: true })!.r2;
  const ausentes = (Object.keys(VARIAVEIS_R2) as (keyof typeof VARIAVEIS_R2)[]).filter((campo) => !r2[campo]);
  if (ausentes.length > 0) {
    throw ApiException.storageNotConfigured(
      `Armazenamento de mídia não configurado neste ambiente (variáveis ausentes: ${ausentes.map((campo) => VARIAVEIS_R2[campo]).join(", ")}).`,
    );
  }
  return r2.publicBaseUrl;
}
