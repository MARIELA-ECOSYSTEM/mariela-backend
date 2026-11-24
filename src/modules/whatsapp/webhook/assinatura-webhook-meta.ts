import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { FORMATO_ASSINATURA_META, FORMATO_CHALLENGE } from "./webhook-meta.constants.js";

/**
 * Fase 22.8.9.10.5 — validação criptográfica do webhook (funções PURAS, sem log).
 *
 * `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 dos BYTES ORIGINAIS do corpo com o App Secret. A comparação é
 * feita sobre os 32 bytes do digest com `timingSafeEqual` (tempo constante). Formato inválido = assinatura inválida.
 */
export function assinaturaWebhookValida(corpoBruto: Buffer, header: unknown, appSecret: string): boolean {
  if (typeof header !== "string") return false;
  const m = FORMATO_ASSINATURA_META.exec(header);
  if (!m) return false;
  const recebida = Buffer.from(m[1]!, "hex");
  const esperada = createHmac("sha256", appSecret).update(corpoBruto).digest();
  return recebida.length === esperada.length && timingSafeEqual(recebida, esperada);
}

/** Comparação em tempo constante de dois textos de tamanhos possivelmente diferentes (compara os SHA-256). */
function textosIguais(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verificação GET: devolve o challenge a ecoar, ou `null` (recusar). Só aceita exatamente o contrato documentado:
 * `hub.mode === "subscribe"`, token igual ao configurado e challenge num formato seguro. Parâmetro repetido (array)
 * ou ausente = recusa.
 */
export function verificarDesafioGet(query: Record<string, unknown>, verifyToken: string): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || typeof token !== "string" || typeof challenge !== "string") return null;
  if (!FORMATO_CHALLENGE.test(challenge)) return null;
  return textosIguais(token, verifyToken) ? challenge : null;
}
