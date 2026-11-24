/**
 * Fase 22.8.9.10.5 — webhook da WhatsApp Cloud API. Fontes oficiais consultadas em 2026-11-24:
 * - developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview e
 *   .../webhooks/create-webhook-endpoint: GET com `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge` (responder
 *   200 com o challenge; senão 4xx); POST JSON com `X-Hub-Signature-256: sha256=<HMAC-SHA256 do corpo com o App
 *   Secret>`; qualquer resposta ≠ 200 é reentregue por até 7 dias (pode haver DUPLICATAS); até 1000 atualizações
 *   por POST; payload de até 3 MB;
 * - .../webhooks/reference/messages (e /status, /text, /errors, /unsupported): `statuses[]` (`id` = wamid,
 *   `status` = sent | delivered | read | failed | played, `timestamp` string, `errors[]` com `code`); `read` pode vir
 *   SEM `delivered` (mensagem lida com o chat aberto); `messages[]` recebidas (`from`, `id`, `type`, `text.body`);
 * - .../webhooks/reference/user_preferences: campo `user_preferences`, `value` = "stop" | "resume" para a categoria
 *   `marketing_messages`, com `wa_id`.
 */

/** Caminho do webhook DENTRO do prefixo global da API (`/{prefixo}/integracoes/whatsapp/webhook`). */
export const CAMINHO_WEBHOOK_WHATSAPP = "integracoes/whatsapp/webhook";

/** Payload documentado de até 3 MB (o parser bruto só existe nesta rota; o limite global da API não muda). */
export const LIMITE_CORPO_WEBHOOK = "3mb";

export const HEADER_ASSINATURA_META = "x-hub-signature-256";

/** `sha256=` + 64 hexadecimais (HMAC-SHA256). Qualquer outro formato é assinatura inválida. */
export const FORMATO_ASSINATURA_META = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * O `hub.challenge` é devolvido no corpo da resposta: só caracteres seguros (a Meta envia um valor aleatório
 * alfanumérico). Qualquer outra coisa é recusada — nunca refletir conteúdo arbitrário.
 */
export const FORMATO_CHALLENGE = /^[A-Za-z0-9._-]{1,256}$/;

/** Segredos da configuração: ASCII visível, sem espaços; mínimo de 16 caracteres (segredo nunca curto). */
export const FORMATO_SEGREDO_WEBHOOK = /^[\x21-\x7E]{16,512}$/;

/** `wa_id`/`from` da Meta: só dígitos (sem `+`). */
export const FORMATO_WA_ID = /^\d{8,15}$/;

/** `timestamp` dos eventos: segundos Unix (string nos `statuses`, inteiro em `user_preferences`). */
export const FORMATO_TIMESTAMP = /^\d{1,12}$/;

/**
 * Tentativas de aplicar UMA transição quando outra escrita concorrente mudou o estado entre a leitura e a escrita
 * condicional (concorrência otimista — NÃO é reenvio de mensagem). Esgotadas, o POST responde 500 e a Meta reentrega.
 */
export const TENTATIVAS_TRANSICAO_STATUS = 5;
