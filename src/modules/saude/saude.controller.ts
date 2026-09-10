import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { SaudeService, type StatusSaude } from "./saude.service.js";

/**
 * Fora do prefixo `/api/v1` de propósito (ver `main.ts`): é o endpoint que
 * um orquestrador/load balancer usa para saber se o processo está de pé,
 * independente de versionamento da API de negócio.
 *
 * Etapa 18.23 — o status HTTP agora reflete `status` do corpo: 200 quando
 * "ok", 503 quando "degradado" (MongoDB indisponível). Antes, o processo
 * sempre respondia 200 mesmo com o banco fora do ar, e um orquestrador que
 * decide só pelo código HTTP (a maioria: Docker HEALTHCHECK, probes de
 * liveness/readiness) nunca detectaria a degradação. `@Res({ passthrough: true })`
 * preserva o corpo rico existente (timestamp/uptime/database) — os
 * interceptors globais continuam processando o valor de retorno normalmente,
 * só o código de status é definido manualmente.
 */
@ApiTags("Saúde")
@Controller("health")
export class SaudeController {
  constructor(private readonly saudeService: SaudeService) {}

  @Get()
  @ApiOperation({ summary: "Verifica se a API e a conexão com o MongoDB estão operacionais." })
  verificar(@Res({ passthrough: true }) res: Response): StatusSaude {
    const status = this.saudeService.verificar();
    res.status(status.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return status;
  }
}
