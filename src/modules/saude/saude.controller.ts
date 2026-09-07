import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SaudeService, type StatusSaude } from "./saude.service.js";

/**
 * Fora do prefixo `/api/v1` de propósito (ver `main.ts`): é o endpoint que
 * um orquestrador/load balancer usa para saber se o processo está de pé,
 * independente de versionamento da API de negócio.
 */
@ApiTags("Saúde")
@Controller("health")
export class SaudeController {
  constructor(private readonly saudeService: SaudeService) {}

  @Get()
  @ApiOperation({ summary: "Verifica se a API e a conexão com o MongoDB estão operacionais." })
  verificar(): StatusSaude {
    return this.saudeService.verificar();
  }
}
