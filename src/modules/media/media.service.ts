import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { ApiFieldError } from "../../common/types/api-response.interface.js";
import type { Configuration } from "../../config/configuration.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { SolicitarUploadDto } from "./dto/solicitar-upload.dto.js";
import {
  EXPIRACAO_UPLOAD_SEGUNDOS,
  MEDIA_PRESIGNER,
  MIME_PERMITIDOS,
  PREFIXO_CHAVE_PRODUTOS,
  ROTULO_TAMANHO_MAXIMO,
  TAMANHO_MAXIMO_BYTES,
  TODOS_OS_MIME_PERMITIDOS,
} from "./media.constants.js";
import type { MediaPresigner, UploadPresignado } from "./media.types.js";

const VARIAVEIS_R2: Record<"accountId" | "accessKeyId" | "secretAccessKey" | "bucketName" | "publicBaseUrl", string> = {
  accountId: "R2_ACCOUNT_ID",
  accessKeyId: "R2_ACCESS_KEY_ID",
  secretAccessKey: "R2_SECRET_ACCESS_KEY",
  bucketName: "R2_BUCKET_NAME",
  publicBaseUrl: "R2_PUBLIC_BASE_URL",
};

/**
 * Upload de mídia do catálogo (imagem/vídeo) direto para o Cloudflare R2 via URL pré-assinada (Fase 40).
 * Autoridade das regras: MIME/extensão/tamanho permitidos, prefixo e unicidade da chave — o cliente nunca
 * informa bucket nem chave. Não persiste nada: a URL pública devolvida é salva pelo Backoffice em
 * `variante.foto`/`variante.video` pelos endpoints de variante já existentes (contrato inalterado).
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly configService: ConfigService<Configuration>,
    private readonly produtosService: ProdutosService,
    @Inject(MEDIA_PRESIGNER) private readonly presigner: MediaPresigner,
  ) {}

  async solicitarUploadPresignado(dto: SolicitarUploadDto): Promise<UploadPresignado> {
    const publicBaseUrl = this.obterBaseUrlPublica();
    const { extensao } = this.validar(dto);
    // Só existência (e não soft-deleted): a mídia sempre nasce sob um produto real — nenhuma regra de Produtos é tocada.
    await this.produtosService.obterPorId(dto.produtoId);

    const key = `${PREFIXO_CHAVE_PRODUTOS}/${dto.produtoId}/${randomUUID()}.${extensao}`;
    const uploadUrl = await this.presigner.assinarUpload({
      key,
      contentType: dto.contentType,
      contentLength: dto.size,
      expiresInSeconds: EXPIRACAO_UPLOAD_SEGUNDOS,
    });

    return {
      uploadUrl,
      method: "PUT",
      headers: { "Content-Type": dto.contentType },
      publicUrl: `${publicBaseUrl}/${key}`,
      key,
      expiresIn: EXPIRACAO_UPLOAD_SEGUNDOS,
    };
  }

  /** Exige as 5 variáveis; a resposta cita só os NOMES das ausentes, nunca valores. */
  private obterBaseUrlPublica(): string {
    const r2 = this.configService.get("storage", { infer: true })!.r2;
    const ausentes = (Object.keys(VARIAVEIS_R2) as (keyof typeof VARIAVEIS_R2)[]).filter((campo) => !r2[campo]);
    if (ausentes.length > 0) {
      throw ApiException.storageNotConfigured(
        `Armazenamento de mídia não configurado neste ambiente (variáveis ausentes: ${ausentes.map((campo) => VARIAVEIS_R2[campo]).join(", ")}).`,
      );
    }
    return r2.publicBaseUrl;
  }

  private validar(dto: SolicitarUploadDto): { extensao: string } {
    const erros: ApiFieldError[] = [];
    const extensoesDoMime = MIME_PERMITIDOS[dto.kind]?.[dto.contentType];

    if (!TODOS_OS_MIME_PERMITIDOS.includes(dto.contentType)) {
      erros.push({ field: "contentType", message: `Tipo de arquivo não permitido. Use: ${TODOS_OS_MIME_PERMITIDOS.join(", ")}.` });
    } else if (!extensoesDoMime) {
      erros.push({ field: "kind", message: `O tipo de arquivo "${dto.contentType}" não corresponde a "${dto.kind}".` });
    } else {
      const nome = dto.fileName.trim();
      const extensaoInformada = nome.includes(".") ? nome.slice(nome.lastIndexOf(".") + 1).toLowerCase() : "";
      if (!extensoesDoMime.includes(extensaoInformada)) {
        erros.push({ field: "fileName", message: `A extensão do arquivo não corresponde a "${dto.contentType}" (esperado: .${extensoesDoMime.join(", .")}).` });
      }
    }

    const limite = TAMANHO_MAXIMO_BYTES[dto.kind];
    if (limite !== undefined && dto.size > limite) {
      erros.push({ field: "size", message: `Arquivo excede o limite de ${ROTULO_TAMANHO_MAXIMO[dto.kind]} para ${dto.kind === "image" ? "imagens" : "vídeos"}.` });
    }

    if (erros.length > 0) throw ApiException.validation("Dados inválidos.", erros);
    return { extensao: extensoesDoMime![0]! };
  }
}
