import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import type { Configuration } from "../../../config/configuration.js";
import type { AssinarUploadParams, InspecaoObjeto, MediaStorage } from "../media.types.js";

/**
 * Storage do Cloudflare R2 (API S3). A assinatura é calculada localmente; `HeadObject`, `GetObject` (Range) e
 * `DeleteObject` (Fase 60.1) falam com o R2. As credenciais vêm exclusivamente de `storage.r2` (variáveis de
 * ambiente) e nunca são logadas nem devolvidas. Qualquer falha do provedor vira `STORAGE_UNAVAILABLE`; objeto
 * ausente (404) é um resultado normal, nunca erro.
 */
@Injectable()
export class R2PresignerProvider implements MediaStorage {
  private readonly logger = new Logger(R2PresignerProvider.name);
  private cliente: S3Client | null = null;

  constructor(private readonly configService: ConfigService<Configuration>) {}

  async assinarUpload({ key, contentType, contentLength, expiresInSeconds, cacheControl }: AssinarUploadParams): Promise<string> {
    const comando = new PutObjectCommand({
      Bucket: this.bucket(),
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
      ...(cacheControl ? { CacheControl: cacheControl } : {}),
    });
    try {
      return await getSignedUrl(this.obterCliente(), comando, {
        expiresIn: expiresInSeconds,
        // Por padrão o presigner assina só `host` e `content-length`. `content-type` PRECISA entrar na assinatura: sem
        // isso o cliente poderia enviar outro tipo (ex.: text/html) para uma URL assinada como imagem. Fase 60.1: o
        // `cache-control` dos uploads da galeria também é assinado, então o objeto nasce com o cache aprovado.
        signableHeaders: new Set(["content-type", "content-length", ...(cacheControl ? ["cache-control"] : [])]),
      });
    } catch (erro) {
      throw this.indisponivel("assinar upload", erro);
    }
  }

  async inspecionarObjeto(key: string): Promise<InspecaoObjeto> {
    try {
      const resposta = await this.obterCliente().send(new HeadObjectCommand({ Bucket: this.bucket(), Key: key }));
      return { existe: true, tamanho: resposta.ContentLength ?? null, contentType: resposta.ContentType ?? null };
    } catch (erro) {
      if (statusHttp(erro) === 404) return { existe: false };
      throw this.indisponivel("inspecionar objeto", erro);
    }
  }

  async lerPrimeirosBytes(key: string, quantidade: number): Promise<Uint8Array | null> {
    try {
      const resposta = await this.obterCliente().send(
        new GetObjectCommand({ Bucket: this.bucket(), Key: key, Range: `bytes=0-${quantidade - 1}` }),
      );
      return resposta.Body ? await resposta.Body.transformToByteArray() : new Uint8Array(0);
    } catch (erro) {
      const status = statusHttp(erro);
      if (status === 404) return null;
      // 416: objeto vazio (nenhum byte no intervalo pedido) — a conferência de assinatura recusa.
      if (status === 416) return new Uint8Array(0);
      throw this.indisponivel("ler bytes do objeto", erro);
    }
  }

  async excluirObjeto(key: string): Promise<void> {
    try {
      await this.obterCliente().send(new DeleteObjectCommand({ Bucket: this.bucket(), Key: key }));
    } catch (erro) {
      throw this.indisponivel("excluir objeto", erro);
    }
  }

  /** Registra só a operação e o NOME do erro (nunca credenciais, URL assinada ou corpo da resposta). */
  private indisponivel(operacao: string, erro: unknown): ApiException {
    const nome = erro instanceof Error ? erro.name : typeof erro;
    this.logger.warn(`Falha no storage de mídia ao ${operacao} (${nome}${statusHttp(erro) ? `, HTTP ${statusHttp(erro)}` : ""}).`);
    return ApiException.storageUnavailable();
  }

  private bucket(): string {
    return this.configService.get("storage", { infer: true })!.r2.bucketName;
  }

  private obterCliente(): S3Client {
    if (!this.cliente) {
      const { accountId, accessKeyId, secretAccessKey } = this.configService.get("storage", { infer: true })!.r2;
      this.cliente = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        // O R2 não aceita os checksums adicionais que versões recentes do SDK incluem por padrão na URL assinada.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
    }
    return this.cliente;
  }
}

/** Status HTTP de um erro do SDK (`$metadata.httpStatusCode`), quando houver. */
function statusHttp(erro: unknown): number | undefined {
  if (typeof erro !== "object" || erro === null || !("$metadata" in erro)) return undefined;
  const metadata = (erro as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}
