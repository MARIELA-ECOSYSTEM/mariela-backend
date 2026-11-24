import type { WhatsappConfig } from "../../../config/configuration.js";
import { FORMATO_CONFIG_META } from "../providers/meta/meta-cloud-api.constants.js";
import { FORMATO_SEGREDO_WEBHOOK } from "./webhook-meta.constants.js";

/** Token de injeção da configuração JÁ VALIDADA do webhook (`null` = webhook desativado). */
export const CONFIG_WEBHOOK_WHATSAPP = Symbol("CONFIG_WEBHOOK_WHATSAPP");

export interface ConfiguracaoWebhookMeta {
  verifyToken: string;
  appSecret: string;
  /** Eventos de outro número (outro Phone Number ID) são ignorados. */
  phoneNumberId: string;
}

export type CampoConfigWebhookMeta = keyof ConfiguracaoWebhookMeta;

export type LeituraConfiguracaoWebhookMeta =
  | { valida: true; config: ConfiguracaoWebhookMeta }
  /** Só NOMES de campo — nunca valores. */
  | { valida: false; camposInvalidos: CampoConfigWebhookMeta[] };

/**
 * Fase 22.8.9.10.5 — o webhook só fica ATIVO com verify token, App Secret e Phone Number ID presentes e bem
 * formados. Função pura: não lê `process.env` nem arquivo algum.
 */
export function lerConfiguracaoWebhookMeta(whatsapp: WhatsappConfig | undefined): LeituraConfiguracaoWebhookMeta {
  const texto = (v: unknown) => (typeof v === "string" ? v : "");
  const verifyToken = texto(whatsapp?.metaWebhook?.verifyToken);
  const appSecret = texto(whatsapp?.metaWebhook?.appSecret);
  const phoneNumberId = texto(whatsapp?.meta?.phoneNumberId);

  const campos: CampoConfigWebhookMeta[] = [];
  if (!FORMATO_SEGREDO_WEBHOOK.test(verifyToken)) campos.push("verifyToken");
  if (!FORMATO_SEGREDO_WEBHOOK.test(appSecret)) campos.push("appSecret");
  if (!FORMATO_CONFIG_META.phoneNumberId.test(phoneNumberId)) campos.push("phoneNumberId");
  if (campos.length > 0) return { valida: false, camposInvalidos: campos };
  return { valida: true, config: { verifyToken, appSecret, phoneNumberId } };
}
