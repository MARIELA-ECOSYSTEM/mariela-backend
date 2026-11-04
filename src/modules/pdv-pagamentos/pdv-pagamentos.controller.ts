import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { PdvJwtAuthGuard } from "../pdv-auth/guards/pdv-jwt-auth.guard.js";
import { PdvPagamentosService } from "./pdv-pagamentos.service.js";

/**
 * Namespace `/pdv/pagamentos` (Fase 59) — autenticação exclusiva do MARIELA PDV
 * (`PdvJwtAuthGuard`, NUNCA `JwtAuthGuard`/`RolesGuard` do Backoffice).
 * Somente leitura: expõe ao vendedor apenas o necessário para montar os
 * pagamentos de `POST /pdv/vendas`. A administração continua exclusiva do
 * Backoffice em `/configuracoes` e `/adquirentes` (ADMIN), sem alteração.
 */
@ApiTags("PDV — Pagamentos")
@ApiBearerAuth()
@UseGuards(PdvJwtAuthGuard)
@Controller("pdv/pagamentos")
export class PdvPagamentosController {
  constructor(private readonly pdvPagamentosService: PdvPagamentosService) {}

  @Get("formas")
  @ApiOperation({ summary: "Formas de pagamento aceitas na venda (pagamentos[].forma), na ordem do cadastro." })
  async listarFormas() {
    return this.pdvPagamentosService.listarFormas();
  }

  @Get("adquirentes")
  @ApiOperation({ summary: "Adquirentes ativas com as modalidades e parcelamentos autorizados (e a tarifa configurada)." })
  async listarAdquirentes() {
    return this.pdvPagamentosService.listarAdquirentes();
  }
}
