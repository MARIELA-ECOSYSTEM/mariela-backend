import type { CodigoRecusaProvedor } from "../../envios/envios-whatsapp.constants.js";

/**
 * Fase 22.8.9.10.4 — Cloud API oficial da Meta (WhatsApp Business Platform). Fontes oficiais consultadas em 2026-11-23:
 * - envio: `POST https://graph.facebook.com/{Version}/{Phone-Number-ID}/messages`, `Authorization: Bearer <token>`
 *   (developers.facebook.com/docs/whatsapp/cloud-api/reference/messages);
 * - corpo do template: developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview;
 * - erros: developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes (decidir por `error.code`; o
 *   `error_subcode` não vem mais desde a v16.0);
 * - consulta de templates: `GET /{WABA-ID}/message_templates`
 *   (developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/);
 * - versões: developers.facebook.com/docs/graph-api/changelog/versions.
 */

/** Únicos provedores aceitos em `WHATSAPP_PROVEDOR_ENVIO`. */
export const PROVEDORES_ENVIO_WHATSAPP = ["desativado", "meta-cloud-api"] as const;
export type NomeProvedorEnvioWhatsapp = (typeof PROVEDORES_ENVIO_WHATSAPP)[number];
export const PROVEDOR_ENVIO_PADRAO: NomeProvedorEnvioWhatsapp = "desativado";

/** Único host aceito. Não é configurável por ambiente (só os testes injetam outro no cliente HTTP). */
export const META_GRAPH_BASE_URL = "https://graph.facebook.com";

/**
 * Versão padrão da Graph API: a mais recente publicada no changelog oficial (v26.0, lançada em 29/07/2026, sem data
 * de expiração definida). Configurável (`META_WHATSAPP_GRAPH_API_VERSION`) para acompanhar a política de versões
 * sem novo deploy de código.
 */
export const META_GRAPH_API_VERSION_PADRAO = "v26.0";

/** Timeout total da chamada (conexão + resposta + corpo). Bem abaixo de `PRAZO_ENVIANDO_MS` (2 min). */
export const META_TIMEOUT_MS_PADRAO = 10_000;
export const META_TIMEOUT_MS_LIMITES = { minimo: 1_000, maximo: 30_000 } as const;

/** Formatos aceitos na configuração. Valores fora disso DESATIVAM o envio (nunca impedem o boot). */
export const FORMATO_CONFIG_META = {
  graphApiVersion: /^v\d{1,3}\.\d{1,3}$/,
  /** IDs da Graph API são numéricos. */
  phoneNumberId: /^\d{5,30}$/,
  businessAccountId: /^\d{5,30}$/,
  /** Só caracteres visíveis ASCII, sem espaço — o token vai num header HTTP. Não validamos a "aparência" do token. */
  accessToken: /^[\x21-\x7E]{1,4096}$/,
} as const;

/** `message_status` do aceite (referência de mensagens). Todos significam que a Meta CRIOU a mensagem (há `id`). */
export const META_STATUS_ACEITE = ["accepted", "held_for_quality_assessment", "paused"] as const;

/** Identificador devolvido em `messages[0].id` — conjunto de caracteres conservador; fora disso = resposta suspeita. */
export const FORMATO_WAMID = /^[A-Za-z0-9._:=+/-]{1,512}$/;

/**
 * Códigos que a Meta descreve como temporários/erro de servidor ("Unknown error", "Service temporarily unavailable",
 * "downtime or overload"). Mesmo com HTTP 4xx, NÃO provam que nada saiu: o resultado é `indeterminada`.
 */
export const META_CODIGOS_INDETERMINADOS: ReadonlySet<number> = new Set([1, 2, 131000, 131016, 133004]);

/**
 * Recusas determinísticas com classificação própria (resposta síncrona com `error.code`). Qualquer outro código numa
 * resposta 4xx estruturada vira `RECUSADA` (genérica).
 */
export const META_CODIGOS_RECUSA: ReadonlyMap<number, CodigoRecusaProvedor> = new Map<number, CodigoRecusaProvedor>([
  // Autenticação/autorização: token inválido, expirado, sem permissão.
  [0, "CREDENCIAL_INVALIDA"],
  [3, "CREDENCIAL_INVALIDA"],
  [10, "CREDENCIAL_INVALIDA"],
  [190, "CREDENCIAL_INVALIDA"],
  [131005, "CREDENCIAL_INVALIDA"],
  // Limites de taxa (app, conta, throughput, par remetente/destinatário).
  [4, "LIMITE_TAXA"],
  [80007, "LIMITE_TAXA"],
  [130429, "LIMITE_TAXA"],
  [131056, "LIMITE_TAXA"],
  // Template: parâmetros, inexistente/não aprovado no idioma, texto, política, pausado, desativado.
  [132000, "TEMPLATE_INVALIDO"],
  [132001, "TEMPLATE_INVALIDO"],
  [132005, "TEMPLATE_INVALIDO"],
  [132007, "TEMPLATE_INVALIDO"],
  [132012, "TEMPLATE_INVALIDO"],
  [132015, "TEMPLATE_INVALIDO"],
  [132016, "TEMPLATE_INVALIDO"],
  // Destinatário.
  [131026, "SEM_WHATSAPP"],
  [131050, "OPT_OUT_MARKETING"],
  [131049, "LIMITE_MARKETING_DESTINATARIO"],
]);

/** Faixa 200–299 = permissão não concedida ou removida. */
export function codigoMetaDePermissao(codigo: number): boolean {
  return codigo >= 200 && codigo <= 299;
}

/** Erros de rede em que comprovadamente NENHUM byte do pedido chegou à Meta (sem conexão estabelecida). */
export const ERROS_REDE_SEM_CONEXAO: ReadonlyMap<string, "CONEXAO_RECUSADA" | "DNS"> = new Map([
  ["ConnectionRefused", "CONEXAO_RECUSADA"],
  ["ECONNREFUSED", "CONEXAO_RECUSADA"],
  ["ENOTFOUND", "DNS"],
  ["EAI_AGAIN", "DNS"],
]);
