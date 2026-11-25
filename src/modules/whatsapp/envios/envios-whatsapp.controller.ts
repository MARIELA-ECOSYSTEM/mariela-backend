import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { CurrentUser } from "../../../common/decorators/current-user.decorator.js";
import { Roles } from "../../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../../common/guards/roles.guard.js";
import {
  EnviarTemplateWhatsappDto,
  EnviarTextoWhatsappDto,
  LiberarReenvioWhatsappDto,
  ListarMensagensWhatsappQueryDto,
  PreviaTemplateWhatsappDto,
} from "../dto/envios-whatsapp.dto.js";
import { WHATSAPP_SEND_THROTTLE_LIMITE, WHATSAPP_SEND_THROTTLE_TTL_MS } from "../whatsapp.constants.js";
import { EnviosWhatsappService } from "./envios-whatsapp.service.js";

/**
 * Fase 22.8.9.10.3 — envio por template, histórico e templates (rotas NOVAS, ao lado das da Evolution, que seguem
 * intactas até a troca de provedor). Só ADMIN. Controller fino: valida via DTO e delega.
 */
@ApiTags("Integrações — WhatsApp (envio por template)")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("integracoes/whatsapp")
export class EnviosWhatsappController {
  constructor(private readonly service: EnviosWhatsappService) {}

  /** 201 = mensagem criada por esta requisição; 200 = repetição da mesma chave (nada é reenviado). */
  @Throttle({ default: { limit: WHATSAPP_SEND_THROTTLE_LIMITE, ttl: WHATSAPP_SEND_THROTTLE_TTL_MS } })
  @Post("envios")
  @ApiOperation({ summary: "Envia uma mensagem de template a um cliente (idempotente pela chave)." })
  async enviar(@Body() dto: EnviarTemplateWhatsappDto, @CurrentUser("sub") usuarioId: string, @Res({ passthrough: true }) res: Response) {
    const { mensagem, nova } = await this.service.enviar(dto, usuarioId ?? null);
    res.status(nova ? HttpStatus.CREATED : HttpStatus.OK);
    return { data: mensagem };
  }

  /**
   * Fase 22.8.9.10.7.4 — texto livre a um cliente cadastrado, só dentro da janela de 24 h (conferida aqui, pelo backend).
   * 201 = mensagem criada por esta requisição; 200 = repetição da mesma chave (nada é reenviado).
   */
  @Throttle({ default: { limit: WHATSAPP_SEND_THROTTLE_LIMITE, ttl: WHATSAPP_SEND_THROTTLE_TTL_MS } })
  @Post("envios/texto")
  @ApiOperation({ summary: "Envia um texto livre a um cliente (só na janela de 24 h; idempotente pela chave)." })
  async enviarTexto(@Body() dto: EnviarTextoWhatsappDto, @CurrentUser("sub") usuarioId: string, @Res({ passthrough: true }) res: Response) {
    const { mensagem, nova } = await this.service.enviarTexto(dto, usuarioId ?? null);
    res.status(nova ? HttpStatus.CREATED : HttpStatus.OK);
    return { data: mensagem };
  }

  @Get("clientes/:id/texto-livre")
  @ApiOperation({ summary: "Se o texto livre pode ser enviado agora a este cliente (janela de 24 h, bloqueio, configuração)." })
  async elegibilidadeTexto(@Param("id") id: string) {
    return { data: await this.service.elegibilidadeTexto(id) };
  }

  @Get("mensagens")
  @ApiOperation({ summary: "Histórico de mensagens (modelos e texto livre), paginado." })
  async listar(@Query() query: ListarMensagensWhatsappQueryDto) {
    return this.service.listar(query);
  }

  @Get("mensagens/:id")
  @ApiOperation({ summary: "Uma mensagem do histórico." })
  async obter(@Param("id") id: string) {
    return { data: await this.service.obter(id) };
  }

  @Post("mensagens/:id/liberar-reenvio")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Liberação MANUAL de reenvio (falha/indeterminada). Não garante ausência de duplicidade." })
  async liberarReenvio(@Param("id") id: string, @Body() dto: LiberarReenvioWhatsappDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.service.liberarReenvio(id, dto, usuarioId ?? null) };
  }

  @Get("templates")
  @ApiOperation({ summary: "Catálogo de templates com o estado de aprovação confirmado no provedor." })
  async templates() {
    return { data: await this.service.listarTemplates() };
  }

  @Post("templates/:chave/previa")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Prévia do template com os dados reais do cliente." })
  async previa(@Param("chave") chave: string, @Body() dto: PreviaTemplateWhatsappDto) {
    return { data: await this.service.previa(chave, dto.clienteId) };
  }
}
