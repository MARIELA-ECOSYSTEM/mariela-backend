/** Parâmetros que o backend (e só ele) fornece ao presigner — nunca vêm direto do cliente. */
export interface AssinarUploadParams {
  key: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
}

/** Abstração do storage S3-compatível: só gera a URL assinada (cálculo local, sem chamada de rede). */
export interface MediaPresigner {
  assinarUpload(params: AssinarUploadParams): Promise<string>;
}

/** Contrato de resposta de `POST /media/presigned-upload`. Nunca contém credenciais. */
export interface UploadPresignado {
  /** URL assinada para o `PUT` direto ao bucket. Válida por `expiresIn` segundos. */
  uploadUrl: string;
  method: "PUT";
  /** Cabeçalhos que o cliente DEVE enviar exatamente assim no `PUT` (fazem parte da assinatura). */
  headers: Record<string, string>;
  /** URL pública final do arquivo — é ela que vai em `foto`/`video` da variante. */
  publicUrl: string;
  /** Chave do objeto no bucket (informativa; sempre sob `products/{produtoId}/`). */
  key: string;
  expiresIn: number;
}
