/** Parâmetros que o backend (e só ele) fornece ao presigner — nunca vêm direto do cliente. */
export interface AssinarUploadParams {
  key: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
  /** Fase 60.1 — quando informado, o `Cache-Control` também entra na assinatura (o cliente precisa enviá-lo igual). */
  cacheControl?: string;
}

/** Abstração do storage S3-compatível: só gera a URL assinada (cálculo local, sem chamada de rede). */
export interface MediaPresigner {
  assinarUpload(params: AssinarUploadParams): Promise<string>;
}

/** Resultado do `HeadObject`: ausência é um resultado normal (o cliente pode não ter enviado), não uma falha do storage. */
export type InspecaoObjeto = { existe: false } | { existe: true; tamanho: number | null; contentType: string | null; etag?: string };

/**
 * Fase 60.4.3.4.1 — leitura COMPLETA do objeto para a validação de conteúdo. `alterado` = o objeto não é mais a
 * versão inspecionada (ETag diferente, `If-Match` → 412) ou passou do tamanho esperado.
 */
export type LeituraObjeto = { estado: "ausente" } | { estado: "alterado" } | { estado: "lido"; bytes: Uint8Array };

export interface LerObjetoOpcoes {
  /** Bytes máximos aceitos (o tamanho registrado na solicitação); acima disso a leitura é `alterado`. */
  tamanhoMaximo: number;
  /** ETag do `HeadObject`: garante que o conteúdo validado é exatamente a versão inspecionada. */
  ifMatch?: string;
}

/**
 * Fase 60.1 — abstração completa do storage de mídia. Toda falha do provedor (rede, credencial, erro do serviço)
 * é sinalizada como `ApiException.storageUnavailable` (`STORAGE_UNAVAILABLE`); objeto ausente nunca é erro.
 */
export interface MediaStorage extends MediaPresigner {
  inspecionarObjeto(key: string): Promise<InspecaoObjeto>;
  /** Primeiros `quantidade` bytes do objeto (Range); `null` se o objeto não existe. */
  lerPrimeirosBytes(key: string, quantidade: number): Promise<Uint8Array | null>;
  /** Fase 60.4.3.4.1 — objeto inteiro (limitado a `tamanhoMaximo`), condicionado ao ETag quando informado. */
  lerObjeto(key: string, opcoes: LerObjetoOpcoes): Promise<LeituraObjeto>;
  /** Capacidade reservada para a limpeza futura (Fase 60.3) — nenhum fluxo desta fase a executa. */
  excluirObjeto(key: string): Promise<void>;
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

/** Contrato de resposta de `POST /produtos/:id/midias/uploads` (Fase 60.1). Sem URL pública: a mídia só existe depois da confirmação. */
export interface UploadGaleriaAutorizado {
  uploadId: string;
  uploadUrl: string;
  method: "PUT";
  /** `Content-Type` e `Cache-Control` — ambos assinados; o `Content-Length` (também assinado) é o `size` declarado. */
  headers: Record<string, string>;
  expiresIn: number;
}
