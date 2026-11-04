/** Token de injeção da abstração de presigner — permite trocar o Cloudflare R2 por outro storage S3-compatível (ou um fake nos testes) sem tocar `MediaService` (mesmo padrão de `WHATSAPP_PROVIDER`). */
export const MEDIA_PRESIGNER = Symbol("MEDIA_PRESIGNER");

export const TIPOS_DE_MIDIA = ["image", "video"] as const;
export type TipoMidia = (typeof TIPOS_DE_MIDIA)[number];

/**
 * MIME permitidos por tipo, com as extensões de nome de arquivo aceitas para cada um (a primeira é a canônica,
 * usada na chave do objeto). O tipo declarado pelo cliente NUNCA é confiado além disso: o R2 não verifica o
 * conteúdo, então o `Content-Type` e o `Content-Length` entram na assinatura (ver `R2PresignerProvider`).
 */
export const MIME_PERMITIDOS: Record<TipoMidia, Readonly<Record<string, readonly string[]>>> = {
  image: {
    "image/jpeg": ["jpg", "jpeg"],
    "image/png": ["png"],
    "image/webp": ["webp"],
    "image/gif": ["gif"],
  },
  video: {
    "video/mp4": ["mp4"],
  },
};

export const TODOS_OS_MIME_PERMITIDOS: readonly string[] = TIPOS_DE_MIDIA.flatMap((tipo) => Object.keys(MIME_PERMITIDOS[tipo]));

const MEGABYTE = 1024 * 1024;
export const TAMANHO_MAXIMO_BYTES: Record<TipoMidia, number> = {
  image: 5 * MEGABYTE,
  video: 15 * MEGABYTE,
};
export const ROTULO_TAMANHO_MAXIMO: Record<TipoMidia, string> = {
  image: "5 MB",
  video: "15 MB",
};

/** Validade da URL de upload — curta de propósito (10 minutos). */
export const EXPIRACAO_UPLOAD_SEGUNDOS = 600;

/** Prefixo controlado pelo backend: o cliente nunca informa bucket nem chave. */
export const PREFIXO_CHAVE_PRODUTOS = "products";

/**
 * Fase 60.1 — token da abstração completa de storage (`MediaStorage`: assinar, inspecionar, ler bytes, excluir).
 * `MEDIA_PRESIGNER` continua existindo e aponta para a MESMA instância (`useExisting`), então o endpoint antigo
 * `POST /media/presigned-upload` segue com seu contrato e trocar o storage num teste troca os dois.
 */
export const MEDIA_STORAGE = Symbol("MEDIA_STORAGE");

/** Limite de mídias ATIVAS na galeria de um produto, por tipo (decisão aprovada na Fase 60.0). */
export const LIMITE_MIDIAS_POR_PRODUTO: Record<TipoMidia, number> = {
  image: 20,
  video: 3,
};

/** Cache dos objetos da galeria: seguro porque a chave nunca é reaproveitada (UUID novo a cada upload). Entra na assinatura do `PUT`. */
export const CACHE_CONTROL_MIDIA = "public, max-age=31536000, immutable";

/**
 * Prazo do REGISTRO pendente em `uploads_midia` (24 h), distinto da validade da URL assinada
 * (`EXPIRACAO_UPLOAD_SEGUNDOS`): depois dele a confirmação é recusada e o registro fica elegível para a limpeza futura.
 */
export const PRAZO_LIMPEZA_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Bytes lidos do início do objeto para conferir a assinatura real do formato (WebP precisa de 12; MP4 de 8). */
export const BYTES_ASSINATURA_FORMATO = 16;

export const ESTADOS_UPLOAD_MIDIA = ["pendente", "confirmado", "removido", "descartado"] as const;
export type EstadoUploadMidia = (typeof ESTADOS_UPLOAD_MIDIA)[number];
