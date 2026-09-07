import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { VendedorPdv } from "../pdv-auth/decorators/vendedor-pdv.decorator.js";
import { PdvJwtAuthGuard } from "../pdv-auth/guards/pdv-jwt-auth.guard.js";
import { CriarVendaPdvDto } from "./dto/criar-venda-pdv.dto.js";
import { PdvVendasService } from "./pdv-vendas.service.js";

/**
 * Namespace `/pdv/vendas` — autenticação exclusiva do MARIELA PDV
 * (`PdvJwtAuthGuard`, NUNCA `JwtAuthGuard`/`RolesGuard` do Backoffice). Único
 * ponto do sistema inteiro que cria venda por HTTP — o Backoffice continua
 * sem `POST /vendas` (ver `vendas.controller.ts`).
 */
@ApiTags("PDV — Vendas")
@ApiBearerAuth()
@UseGuards(PdvJwtAuthGuard)
@Controller("pdv/vendas")
export class PdvVendasController {
  constructor(private readonly pdvVendasService: PdvVendasService) {}

  @Post()
  @ApiOperation({
    summary: "Cria a venda. Vendedor e caixa são resolvidos do contexto autenticado — nunca aceitos do payload.",
  })
  async criar(@Body() dto: CriarVendaPdvDto, @VendedorPdv("id") vendedorId: string) {
    return { data: await this.pdvVendasService.criar(vendedorId, dto) };
  }
}
