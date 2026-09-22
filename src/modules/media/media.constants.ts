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
