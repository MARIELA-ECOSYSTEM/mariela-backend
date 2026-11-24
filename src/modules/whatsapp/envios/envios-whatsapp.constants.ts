/**
 * Fase 22.8.9.10.3 — envio de WhatsApp por TEMPLATE (preparação para a Cloud API da Meta). Constantes do registro
 * persistente de mensagens (`mensagens_whatsapp`) e da lista de bloqueio (`whatsapp_bloqueios`). Especificação:
 * 22.8.9.10.2 consolidada (itens A–G).
 */

/**
 * Estados de uma mensagem:
 * - `pendente`: reservada (chave de idempotência gravada), ainda SEM posse do envio — a chamada ao provedor não
 *   começou. Abandonada (> `PRAZO_POSSE_MS`) vira `falha`/`NAO_ENVIADA`: comprovadamente não enviada.
 * - `enviando`: posse adquirida ANTES da chamada HTTP. Abandonada (> `PRAZO_ENVIANDO_MS`) vira `indeterminada`.
 * - `aceita` → `entregue` → `lida`: confirmações do provedor (as duas últimas virão do webhook, Fase 22.8.9.10.5).
 * - `falha`: recusa definitiva. `indeterminada`: não se sabe se saiu — NUNCA reenviada automaticamente.
 */
export const ESTADOS_MENSAGEM_WHATSAPP = ["pendente", "enviando", "aceita", "entregue", "lida", "falha", "indeterminada"] as const;
export type EstadoMensagemWhatsapp = (typeof ESTADOS_MENSAGEM_WHATSAPP)[number];

/**
 * Classificação interna e estável das falhas (o código bruto do provedor fica só em `erroCodigoProvedor`).
 * `NAO_ENVIADA` e `PROVEDOR_INDISPONIVEL` são as únicas que comprovam que nada saiu; `INDETERMINADO` é a dúvida.
 */
export const CODIGOS_ERRO_ENVIO_WHATSAPP = [
  "NAO_ENVIADA",
  "PROVEDOR_INDISPONIVEL",
  "SEM_WHATSAPP",
  "OPT_OUT_MARKETING",
  "LIMITE_MARKETING_DESTINATARIO",
  "TEMPLATE_INVALIDO",
  "LIMITE_TAXA",
  "CREDENCIAL_INVALIDA",
  "RECUSADA",
  "INDETERMINADO",
] as const;
export type CodigoErroEnvioWhatsapp = (typeof CODIGOS_ERRO_ENVIO_WHATSAPP)[number];

/** Recusas que o PROVEDOR pode devolver (as outras duas são decididas pelo próprio MARIELA). */
export type CodigoRecusaProvedor = Exclude<CodigoErroEnvioWhatsapp, "NAO_ENVIADA" | "INDETERMINADO">;

export const ORIGENS_MENSAGEM_WHATSAPP = ["INDIVIDUAL", "CAMPANHA_ANIVERSARIO"] as const;
export type OrigemMensagemWhatsapp = (typeof ORIGENS_MENSAGEM_WHATSAPP)[number];

export const TIPOS_CAMPANHA_WHATSAPP = ["ANIVERSARIO"] as const;
export type TipoCampanhaWhatsapp = (typeof TIPOS_CAMPANHA_WHATSAPP)[number];

/** Escopo inicial: só clientes (Fase 22.8.9.10.2, §2). */
export const TIPOS_DESTINATARIO_ENVIO_WHATSAPP = ["CLIENTE"] as const;
export type TipoDestinatarioEnvioWhatsapp = (typeof TIPOS_DESTINATARIO_ENVIO_WHATSAPP)[number];

/**
 * `PALAVRA_CHAVE` é LEGADO (Fase 22.8.9.10.7.2): nenhum código cria mais bloqueios com essa origem. Continua aceita
 * para que registros históricos sigam válidos, consultáveis (`origem: "PALAVRA_CHAVE"`) e desbloqueáveis pelo ADMIN.
 */
export const ORIGENS_BLOQUEIO_WHATSAPP = ["ADMIN", "PALAVRA_CHAVE", "META_OPT_OUT"] as const;
export type OrigemBloqueioWhatsapp = (typeof ORIGENS_BLOQUEIO_WHATSAPP)[number];

export const TIPOS_CHAVE_BLOQUEIO_WHATSAPP = ["E164", "WAID"] as const;
export type TipoChaveBloqueioWhatsapp = (typeof TIPOS_CHAVE_BLOQUEIO_WHATSAPP)[number];

/** `pendente` sem posse há mais que isto → `falha`/`NAO_ENVIADA` (proposta da spec; valor a validar). */
export const PRAZO_POSSE_MS = 2 * 60_000;
/** `enviando` há mais que isto → `indeterminada` (bem acima do timeout do provedor, ~10 s). */
export const PRAZO_ENVIANDO_MS = 2 * 60_000;
/** Salvaguarda mínima antes de liberar uma `indeterminada` — dá tempo a um webhook tardio; NÃO prova nada. */
export const PRAZO_MINIMO_LIBERAR_INDETERMINADA_MS = 24 * 60 * 60_000;
/** Validade do resultado de uma consulta de template ao provedor. Resultado vencido nunca é reaproveitado. */
export const VALIDADE_CACHE_TEMPLATE_MS = 10 * 60_000;

export const PAGINA_PADRAO_WHATSAPP = 1;
export const LIMITE_PADRAO_WHATSAPP = 20;
export const LIMITE_MAXIMO_WHATSAPP = 100;

/** Fuso da loja — o ano da campanha é o ano CIVIL DO ENVIO neste fuso (decisão da Fase 22.8.9.10.3). */
export const FUSO_LOJA = "America/Sao_Paulo";
