import { Module } from "@nestjs/common";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { MEDIA_PRESIGNER } from "./media.constants.js";
import { MediaController } from "./media.controller.js";
import { MediaService } from "./media.service.js";
import { R2PresignerProvider } from "./providers/r2-presigner.provider.js";

/** Importa Produtos só para conferir a existência do produto (leitura) — nenhuma regra de Produtos/Variante é alterada. */
@Module({
  imports: [ProdutosModule],
  controllers: [MediaController],
  providers: [MediaService, { provide: MEDIA_PRESIGNER, useClass: R2PresignerProvider }],
  exports: [MediaService],
})
export class MediaModule {}
