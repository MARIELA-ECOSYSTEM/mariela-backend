import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { SolicitarUploadDto } from "./dto/solicitar-upload.dto.js";
import { MediaService } from "./media.service.js";

/**
 * Controller fino (mesmo padrão de `WhatsappController`). Só o Backoffice (`JwtAuthGuard` + `ADMIN`): o token do
 * PDV é assinado com outro segredo e nunca é aceito aqui.
 */
@ApiTags("Mídia")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("media")
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post("presigned-upload")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Gera uma URL pré-assinada (10 min) para enviar imagem/vídeo direto ao Cloudflare R2.",
    description:
      "Nada é gravado no banco. O cliente faz `PUT` em `uploadUrl` com os `headers` devolvidos e o mesmo tamanho declarado; " +
      "depois salva `publicUrl` em `foto`/`video` da variante pelos endpoints de variante já existentes.",
  })
  async solicitarUpload(@Body() dto: SolicitarUploadDto) {
    return { data: await this.mediaService.solicitarUploadPresignado(dto) };
  }
}
