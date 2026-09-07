import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { VendedorPdv } from "../pdv-auth/decorators/vendedor-pdv.decorator.js";
import { PdvJwtAuthGuard } from "../pdv-auth/guards/pdv-jwt-auth.guard.js";
import { AbrirCaixaPdvDto } from "./dto/abrir-caixa-pdv.dto.js";
import { PdvCaixaService } from "./pdv-caixa.service.js";

/**
 * Namespace `/pdv/caixa` — autenticação exclusiva do MARIELA PDV
 * (`PdvJwtAuthGuard`, NUNCA `JwtAuthGuard`/`RolesGuard` do Backoffice). Não
 * expõe fechamento nem entrada/saída manual: essas operações continuam
 * exclusivas do ADMIN em `/caixas/*` (ver `caixas.controller.ts`).
 */
@ApiTags("PDV — Caixa")
@ApiBearerAuth()
@UseGuards(PdvJwtAuthGuard)
@Controller("pdv/caixa")
export class PdvCaixaController {
  constructor(private readonly pdvCaixaService: PdvCaixaService) {}

  @Get("atual")
  @ApiOperation({ summary: "Caixa aberto no momento — compartilhado por todos os vendedores. `null` quando nenhum está aberto." })
  async atual() {
    return { data: await this.pdvCaixaService.atual() };
  }

  @Post("abertura")
  @ApiOperation({ summary: "Abre um novo caixa — o vendedor autenticado é sempre o responsável, nunca um valor enviado pelo cliente." })
  async abrir(@Body() dto: AbrirCaixaPdvDto, @VendedorPdv("id") vendedorId: string) {
    return { data: await this.pdvCaixaService.abrir(vendedorId, dto) };
  }
}
