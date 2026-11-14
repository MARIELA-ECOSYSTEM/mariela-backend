import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { ChaveIdempotenciaInvalidaError, lerChaveIdempotencia } from "./recuperacao-refresh.crypto.js";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { AUTH_LOGIN_THROTTLE_LIMITE, AUTH_LOGIN_THROTTLE_TTL_MS } from "./auth.constants.js";
import type { ContextoRequisicao } from "./auth.service.js";
import { AuthService } from "./auth.service.js";
import { LoginDto } from "./dto/login.dto.js";
import { RefreshTokenDto } from "./dto/refresh-token.dto.js";

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Etapa 24 — sobrescreve o throttler "default" (global, ver `AppModule`) com um limite bem mais restrito para este endpoint (ver `auth.constants.ts`). */
  @Throttle({ default: { limit: AUTH_LOGIN_THROTTLE_LIMITE, ttl: AUTH_LOGIN_THROTTLE_TTL_MS } })
  @Post("login")
  @ApiOperation({ summary: "Login administrativo — devolve access token, refresh token e o usuário." })
  async login(@Body() dto: LoginDto, @Req() request: Request) {
    return { data: await this.authService.login(dto, this.extrairContexto(request)) };
  }

  /**
   * Fase 22.8.7.2 — `Idempotency-Key` OPCIONAL (cabeçalho, nunca no corpo — o corpo continua estrito,
   * `forbidNonWhitelisted`). Sem ele: comportamento anterior. Com ele: precisa ser um UUID canônico, senão 400
   * `VALIDATION_ERROR` ANTES de qualquer leitura ou escrita da sessão (o valor nunca aparece na resposta nem em log).
   * Permitido pelo CORS desde a Fase 58 (`CABECALHOS_CORS`).
   */
  @Post("refresh")
  @ApiOperation({ summary: "Renova a sessão: revoga o refresh token informado e emite um par novo (rotação)." })
  @ApiHeader({
    name: "Idempotency-Key",
    required: false,
    description: "UUID da tentativa de renovação; repetir a MESMA chave com o MESMO refresh token recupera o par já emitido (até 15 min, 5 vezes).",
  })
  async refresh(@Body() dto: RefreshTokenDto, @Req() request: Request, @Headers("idempotency-key") chave?: string) {
    let chaveIdempotencia: string | null;
    try {
      chaveIdempotencia = lerChaveIdempotencia(chave);
    } catch (erro) {
      if (erro instanceof ChaveIdempotenciaInvalidaError) {
        throw ApiException.validation("Dados inválidos.", [{ field: "Idempotency-Key", message: erro.message }]);
      }
      throw erro;
    }
    return { data: await this.authService.refresh(dto, this.extrairContexto(request), chaveIdempotencia) };
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
