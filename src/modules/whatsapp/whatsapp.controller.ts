import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { EnviarMensagemWhatsappDto } from "./dto/enviar-mensagem-whatsapp.dto.js";
import { WhatsappService } from "./whatsapp.service.js";

/**
 * Controller fino (mesmo padrão de `AdquirentesController`): valida via DTO +
 * ValidationPipe global, delega ao service, devolve o resultado. Nenhum
 * detalhe da Evolution API aparece aqui — só o vocabulário do domínio MARIELA
 * (Etapa Pré-22, §3).
 */
@ApiTags("Integrações — WhatsApp")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("integracoes/whatsapp")
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get("status")
  @ApiOperation({ summary: "Estado atual da instância de WhatsApp (provider, número, conexão)." })
  async status() {
    return { data: await this.whatsappService.obterStatus() };
  }

  @Post("conectar")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Inicia/retoma a conexão da instância. Pode devolver um QR Code para escanear." })
  async conectar() {
    return { data: await this.whatsappService.conectar() };
  }

  @Post("desconectar")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Desconecta a sessão do WhatsApp da loja (não remove a configuração)." })
  async desconectar() {
    return { data: await this.whatsappService.desconectar() };
  }

  @Post("mensagens")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Envia uma mensagem de WhatsApp para um Cliente, Fornecedor ou Vendedor cadastrado." })
  async enviarMensagem(@Body() dto: EnviarMensagemWhatsappDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.whatsappService.enviarMensagem(dto, usuarioId) };
  }
}
