import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { VendedorPdv } from "./decorators/vendedor-pdv.decorator.js";
import { LoginPdvDto } from "./dto/login-pdv.dto.js";
import { RefreshPdvDto } from "./dto/refresh-pdv.dto.js";
import { PdvJwtAuthGuard } from "./guards/pdv-jwt-auth.guard.js";
import { PdvAuthService } from "./pdv-auth.service.js";
import type { ContextoRequisicaoPdv, VendedorPublicoPdv } from "./pdv-auth.types.js";

/**
 * Autenticação do MARIELA PDV — identidade de Vendedor, completamente
 * separada do login administrativo (`AuthController`, `/auth/*`). Nenhuma
 * rota aqui aceita ou emite um token compatível com o Backoffice, e
 * vice-versa (ver `PdvJwtAuthGuard`/`JwtAuthGuard`).
 */
@ApiTags("PDV — Autenticação")
@Controller("pdv/auth")
export class PdvAuthController {
  constructor(private readonly pdvAuthService: PdvAuthService) {}

  @Post("login")
  @ApiOperation({ summary: "Login do vendedor no MARIELA PDV (código + senha) — devolve access token, refresh token e a identidade do vendedor." })
  async login(@Body() dto: LoginPdvDto, @Req() request: Request) {
    return { data: await this.pdvAuthService.login(dto, this.extrairContexto(request)) };
  }

  @Post("refresh")
  @ApiOperation({ summary: "Renova a sessão do vendedor: revoga o refresh token informado e emite um par novo (rotação)." })
  async refresh(@Body() dto: RefreshPdvDto, @Req() request: Request) {
    return { data: await this.pdvAuthService.refresh(dto, this.extrairContexto(request)) };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoga o refresh token informado — encerra a sessão do vendedor no servidor." })
  async logout(@Body() dto: RefreshPdvDto) {
    await this.pdvAuthService.logout(dto);
    return { data: { ok: true } };
  }

  @Get("me")
  @UseGuards(PdvJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Identidade do vendedor autenticado pelo access token atual do PDV." })
  async me(@VendedorPdv() vendedor: VendedorPublicoPdv) {
    return { data: vendedor };
  }

  private extrairContexto(request: Request): ContextoRequisicaoPdv {
    return { ip: request.ip ?? null, userAgent: request.headers["user-agent"] ?? null };
  }
}
