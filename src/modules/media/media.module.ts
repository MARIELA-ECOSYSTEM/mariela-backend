import { Module } from "@nestjs/common";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { GaleriaController } from "./galeria.controller.js";
import { GaleriaService } from "./galeria.service.js";
import { MEDIA_PRESIGNER, MEDIA_STORAGE } from "./media.constants.js";
import { MediaController } from "./media.controller.js";
import { MediaService } from "./media.service.js";
import { R2PresignerProvider } from "./providers/r2-presigner.provider.js";
import { UploadsMidiaModule } from "./uploads/uploads-midia.module.js";
import { ValidadorMidiaService } from "./validacao/validador-midia.service.js";

/**
 * Importa Produtos para conferir a existência do produto e, desde a Fase 60.1, para gravar a galeria pelo
 * `ProdutosRepository.salvarComRetentativa` (o mesmo controle de concorrência de todas as mutações do produto).
 * `MEDIA_PRESIGNER` reaproveita a instância de `MEDIA_STORAGE` (`useExisting`).
 */
@Module({
  imports: [ProdutosModule, UploadsMidiaModule],
  controllers: [MediaController, GaleriaController],
  providers: [
    MediaService,
    GaleriaService,
    ValidadorMidiaService,
    { provide: MEDIA_STORAGE, useClass: R2PresignerProvider },
    { provide: MEDIA_PRESIGNER, useExisting: MEDIA_STORAGE },
  ],
  exports: [MediaService],
})
export class MediaModule {}
