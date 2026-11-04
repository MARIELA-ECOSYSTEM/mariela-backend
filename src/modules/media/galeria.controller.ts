import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AssociarVarianteMidiaDto, ConfirmarUploadDto, DefinirMidiaPrincipalDto, ReordenarMidiasDto, SolicitarUploadGaleriaDto } from "./dto/galeria.dto.js";
import { GaleriaService } from "./galeria.service.js";

/**
 * Fase 60.1 — galeria de mídia do produto. Controller fino (mesmo padrão de `MediaController`): só o Backoffice
 * (`JwtAuthGuard` + `ADMIN`); o token do PDV é assinado com outro segredo e nunca é aceito aqui.
 */
@ApiTags("Mídia — Galeria do produto")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("produtos")
export class GaleriaController {
  constructor(private readonly galeriaService: GaleriaService) {}

  @Post(":id/midias/uploads")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Autoriza o envio de uma imagem/vídeo da galeria (URL pré-assinada de 10 min).",
    description:
      "Registra o upload como pendente e devolve `uploadId`, `uploadUrl`, `method` e os `headers` que o `PUT` deve enviar exatamente assim " +
      "(Content-Type e Cache-Control assinados; Content-Length = `size`). A galeria não muda até a confirmação.",
  })
  async solicitarUpload(@Param("id") id: string, @Body() dto: SolicitarUploadGaleriaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.galeriaService.solicitarUpload(id, dto, usuarioId) };
  }

  @Post(":id/midias/uploads/:uploadId/confirmacao")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Confirma o upload: verifica o objeto no storage e inclui a mídia na galeria (idempotente).",
    description: "Opcional: `varianteId` (só imagem), `principal` (só imagem) e `substituiMidiaId` (herda ordem, variante e principal).",
  })
  async confirmarUpload(@Param("id") id: string, @Param("uploadId") uploadId: string, @Body() dto: ConfirmarUploadDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.galeriaService.confirmarUpload(id, uploadId, dto, usuarioId) };
  }

  @Get(":id/midias")
  @ApiOperation({ summary: "Galeria do produto: mídias pela ordem e a imagem principal efetiva." })
  async listar(@Param("id") id: string) {
    return { data: await this.galeriaService.listar(id) };
  }

  @Put(":id/midias/principal")
  @ApiOperation({ summary: "Define a imagem principal (somente imagem da própria galeria)." })
  async definirPrincipal(@Param("id") id: string, @Body() dto: DefinirMidiaPrincipalDto) {
    return { data: await this.galeriaService.definirPrincipal(id, dto.midiaId) };
  }

  @Put(":id/midias/ordem")
  @ApiOperation({ summary: "Reordena a galeria: recebe a lista completa das mídias atuais na nova ordem." })
  async reordenar(@Param("id") id: string, @Body() dto: ReordenarMidiasDto) {
    return { data: await this.galeriaService.reordenar(id, dto.midiaIds) };
  }

  @Patch(":id/midias/:midiaId")
  @ApiOperation({ summary: "Associa uma imagem a uma variante do produto, ou desassocia (`varianteId: null`)." })
  async associarVariante(@Param("id") id: string, @Param("midiaId") midiaId: string, @Body() dto: AssociarVarianteMidiaDto) {
    return { data: await this.galeriaService.associarVariante(id, midiaId, dto.varianteId) };
  }

  @Delete(":id/midias/:midiaId")
  @ApiOperation({ summary: "Remove a mídia da galeria (o arquivo no storage não é apagado nesta fase)." })
  async remover(@Param("id") id: string, @Param("midiaId") midiaId: string) {
    return { data: await this.galeriaService.remover(id, midiaId) };
  }
}
