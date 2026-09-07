import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import type { ContextoRequisicao } from "./auth.service.js";
import { AuthService } from "./auth.service.js";
import { LoginDto } from "./dto/login.dto.js";
import { RefreshTokenDto } from "./dto/refresh-token.dto.js";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  @ApiOperation({ summary: "Login administrativo — devolve access token, refresh token e o usuário." })
  async login(@Body() dto: LoginDto, @Req() request: Request) {
    return { data: await this.authService.login(dto, this.extrairContexto(request)) };
  }

  @Post("refresh")
  @ApiOperation({ summary: "Renova a sessão: revoga o refresh token informado e emite um par novo (rotação)." })
  async refresh(@Body() dto: RefreshTokenDto, @Req() request: Request) {
    return { data: await this.authService.refresh(dto, this.extrairContexto(request)) };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoga o refresh token informado — encerra a sessão no servidor, não só no cliente." })
  async logout(@Body() dto: RefreshTokenDto) {
    await this.authService.logout(dto);
    return { data: { ok: true } };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Usuário autenticado pelo access token atual." })
  async me(@CurrentUser("sub") usuarioId: string) {
    return { data: await this.authService.me(usuarioId) };
  }

  private extrairContexto(request: Request): ContextoRequisicao {
    return { ip: request.ip ?? null, userAgent: request.headers["user-agent"] ?? null };
  }
}
