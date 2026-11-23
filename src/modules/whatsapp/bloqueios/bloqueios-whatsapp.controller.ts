import { Body, Controller, Delete, Get, HttpStatus, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { CurrentUser } from "../../../common/decorators/current-user.decorator.js";
import { Roles } from "../../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../../common/guards/roles.guard.js";
import {
  BloquearContatoWhatsappDto,
  DesbloquearContatoWhatsappDto,
  ListarBloqueiosWhatsappQueryDto,
} from "../dto/envios-whatsapp.dto.js";
import { BloqueiosWhatsappService } from "./bloqueios-whatsapp.service.js";

/** Fase 22.8.9.10.3 — bloqueio simplificado de contato (opt-out) por número. Só ADMIN. */
@ApiTags("Integrações — WhatsApp (bloqueios)")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("integracoes/whatsapp")
export class BloqueiosWhatsappController {
  constructor(private readonly service: BloqueiosWhatsappService) {}

  @Get("clientes/:id/bloqueio")
  @ApiOperation({ summary: "Situação de bloqueio do número atual do cliente." })
  async status(@Param("id") id: string) {
    return { data: await this.service.statusDoCliente(id) };
  }

  /** 201 = bloqueio criado; 200 = o número já estava bloqueado (idempotente). */
  @Post("clientes/:id/bloqueio")
  @ApiOperation({ summary: "Bloqueia o número atual do cliente (pedido de não contato)." })
  async bloquear(
    @Param("id") id: string,
    @Body() dto: BloquearContatoWhatsappDto,
    @CurrentUser("sub") usuarioId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { bloqueio, criado } = await this.service.bloquearCliente(id, dto.motivo?.trim() || null, usuarioId ?? null);
    res.status(criado ? HttpStatus.CREATED : HttpStatus.OK);
    return { data: bloqueio };
  }

  @Delete("clientes/:id/bloqueio")
  @ApiOperation({ summary: "Remove os bloqueios ativos do cliente (motivo obrigatório; o histórico é preservado)." })
  async desbloquear(@Param("id") id: string, @Body() dto: DesbloquearContatoWhatsappDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.service.desbloquearCliente(id, dto.motivo.trim(), usuarioId ?? null) };
  }

  @Get("bloqueios")
  @ApiOperation({ summary: "Lista de bloqueios (inclusive de números sem cliente ativo), números mascarados." })
  async listar(@Query() query: ListarBloqueiosWhatsappQueryDto) {
    return this.service.listar(query.somenteAtivos !== "false", query.page, query.limit);
  }

  @Delete("bloqueios/:id")
  @ApiOperation({ summary: "Remove um bloqueio pelo id (motivo obrigatório; o histórico é preservado)." })
  async desbloquearPorId(@Param("id") id: string, @Body() dto: DesbloquearContatoWhatsappDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.service.desbloquearPorId(id, dto.motivo.trim(), usuarioId ?? null) };
  }
}
