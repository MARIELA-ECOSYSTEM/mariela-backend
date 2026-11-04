import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Configuration } from "../../config/configuration.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { SolicitarUploadDto } from "./dto/solicitar-upload.dto.js";
import { exigirBaseUrlPublica } from "./media-config.util.js";
import { validarArquivoDeclarado } from "./media-validacao.util.js";
import { EXPIRACAO_UPLOAD_SEGUNDOS, MEDIA_PRESIGNER, PREFIXO_CHAVE_PRODUTOS } from "./media.constants.js";
import type { MediaPresigner, UploadPresignado } from "./media.types.js";

/**
 * Upload de mídia do catálogo (imagem/vídeo) direto para o Cloudflare R2 via URL pré-assinada (Fase 40).
 * Autoridade das regras: MIME/extensão/tamanho permitidos, prefixo e unicidade da chave — o cliente nunca
 * informa bucket nem chave. Não persiste nada: a URL pública devolvida é salva pelo Backoffice em
 * `variante.foto`/`variante.video` pelos endpoints de variante já existentes (contrato inalterado).
 *
 * Fase 60.1 — contrato mantido sem alteração (inclusive sem `Cache-Control`) durante a transição; a galeria usa
 * `GaleriaService` (`/produtos/:id/midias`). Validação e checagem de configuração agora são compartilhadas.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly configService: ConfigService<Configuration>,
    private readonly produtosService: ProdutosService,
    @Inject(MEDIA_PRESIGNER) private readonly presigner: MediaPresigner,
  ) {}

  async solicitarUploadPresignado(dto: SolicitarUploadDto): Promise<UploadPresignado> {
    const publicBaseUrl = exigirBaseUrlPublica(this.configService);
    const { extensao } = validarArquivoDeclarado(dto);
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
}
