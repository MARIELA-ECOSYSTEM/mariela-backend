import type { WhatsappConfig } from "../../../../config/configuration.js";
import { FORMATO_CONFIG_META, META_TIMEOUT_MS_LIMITES } from "./meta-cloud-api.constants.js";

/** Configuração da Meta já validada — só existe se TODOS os campos estiverem presentes e bem formados. */
export interface ConfiguracaoMetaValida {
  graphApiVersion: string;
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  timeoutMs: number;
}

export type CampoConfigMeta = keyof ConfiguracaoMetaValida;

export type LeituraConfiguracaoMeta =
  | { valida: true; config: ConfiguracaoMetaValida }
  /** `camposInvalidos` traz só NOMES de campo — nunca valores (o token é credencial). */
  | { valida: false; camposInvalidos: CampoConfigMeta[] };

/**
 * Fase 22.8.9.10.4 — valida a configuração da Cloud API. Incompleta ou malformada = inválida (o envio fica
 * desativado). Função pura: não lê `process.env` nem arquivo algum.
 */
export function lerConfiguracaoMeta(meta: WhatsappConfig["meta"] | undefined): LeituraConfiguracaoMeta {
  const campos: CampoConfigMeta[] = [];
  const texto = (v: unknown) => (typeof v === "string" ? v : "");

  const graphApiVersion = texto(meta?.graphApiVersion);
  const phoneNumberId = texto(meta?.phoneNumberId);
  const businessAccountId = texto(meta?.businessAccountId);
  const accessToken = texto(meta?.accessToken);
  const timeoutMs = meta?.timeoutMs;

  if (!FORMATO_CONFIG_META.graphApiVersion.test(graphApiVersion)) campos.push("graphApiVersion");
  if (!FORMATO_CONFIG_META.phoneNumberId.test(phoneNumberId)) campos.push("phoneNumberId");
  if (!FORMATO_CONFIG_META.businessAccountId.test(businessAccountId)) campos.push("businessAccountId");
  if (!FORMATO_CONFIG_META.accessToken.test(accessToken)) campos.push("accessToken");
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < META_TIMEOUT_MS_LIMITES.minimo ||
    timeoutMs > META_TIMEOUT_MS_LIMITES.maximo
  ) {
    campos.push("timeoutMs");
  }

  if (campos.length > 0) return { valida: false, camposInvalidos: campos };
  return { valida: true, config: { graphApiVersion, phoneNumberId, businessAccountId, accessToken, timeoutMs: timeoutMs as number } };
}
