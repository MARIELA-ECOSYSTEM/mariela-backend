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
  /** Fase 22.8.9.10.7.4 — a Meta recusou texto livre fora da janela de atendimento (código 131047). */
  "JANELA_FECHADA",
  "INDETERMINADO",
] as const;
export type CodigoErroEnvioWhatsapp = (typeof CODIGOS_ERRO_ENVIO_WHATSAPP)[number];

/** Recusas que o PROVEDOR pode devolver (as outras duas são decididas pelo próprio MARIELA). */
export type CodigoRecusaProvedor = Exclude<CodigoErroEnvioWhatsapp, "NAO_ENVIADA" | "INDETERMINADO">;

/**
 * Fase 22.8.9.10.7.4 — `TEMPLATE`: modelo aprovado do catálogo (parâmetros do cadastro). `TEXTO`: texto livre escrito
 * pelo operador, só dentro da janela de atendimento de 24 h. Registros anteriores a esta fase não têm o campo e são
 * lidos como `TEMPLATE` (padrão do schema).
 */
export const TIPOS_MENSAGEM_WHATSAPP = ["TEMPLATE", "TEXTO"] as const;
export type TipoMensagemWhatsapp = (typeof TIPOS_MENSAGEM_WHATSAPP)[number];

/** Limite do corpo de uma mensagem de texto na Cloud API (`text.body`: 4096 caracteres). Medido em unidades UTF-16. */
export const LIMITE_TEXTO_LIVRE_WHATSAPP = 4096;

/**
 * Janela de atendimento (customer service window) da Meta: texto livre só pode ser enviado até 24 h depois da ÚLTIMA
 * mensagem recebida do contato. A margem de segurança fecha a janela um pouco antes, para cobrir a diferença de relógio
 * entre o backend e a Meta e o tempo entre a verificação e a chamada.
 */
export const JANELA_ATENDIMENTO_MS = 24 * 60 * 60_000;
export const MARGEM_SEGURANCA_JANELA_MS = 10 * 60_000;
/** Registros de janela sem mensagem nova há mais que isto são removidos pelo MongoDB (índice TTL). */
export const RETENCAO_JANELA_SEGUNDOS = 30 * 24 * 60 * 60;

/** Por que o texto livre NÃO pode ser enviado agora (`null` quando pode). */
export const MOTIVOS_TEXTO_LIVRE_INDISPONIVEL = [
  "PROVEDOR_NAO_CONFIGURADO",
  "WEBHOOK_NAO_CONFIGURADO",
  "TELEFONE_INVALIDO",
  "CONTATO_BLOQUEADO",
  "SEM_MENSAGEM_RECEBIDA",
  "JANELA_EXPIRADA",
] as const;
export type MotivoTextoLivreIndisponivel = (typeof MOTIVOS_TEXTO_LIVRE_INDISPONIVEL)[number];

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
