import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Configuration } from "../../../config/configuration.js";
import type { AssinarUploadParams, MediaPresigner } from "../media.types.js";

/**
 * Presigner do Cloudflare R2 (API S3). Só calcula a assinatura localmente — nenhuma chamada de rede é feita aqui.
 * As credenciais vêm exclusivamente de `storage.r2` (variáveis de ambiente) e nunca são logadas nem devolvidas.
 */
@Injectable()
export class R2PresignerProvider implements MediaPresigner {
  private cliente: S3Client | null = null;

  constructor(private readonly configService: ConfigService<Configuration>) {}

  async assinarUpload({ key, contentType, contentLength, expiresInSeconds }: AssinarUploadParams): Promise<string> {
    const { bucketName } = this.configService.get("storage", { infer: true })!.r2;
    const comando = new PutObjectCommand({ Bucket: bucketName, Key: key, ContentType: contentType, ContentLength: contentLength });
    return getSignedUrl(this.obterCliente(), comando, {
      expiresIn: expiresInSeconds,
      // Por padrão o presigner assina só `host` e `content-length`. `content-type` PRECISA entrar na assinatura: sem
      // isso o cliente poderia enviar outro tipo (ex.: text/html) para uma URL assinada como imagem.
      signableHeaders: new Set(["content-type", "content-length"]),
    });
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
