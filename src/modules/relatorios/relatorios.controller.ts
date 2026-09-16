import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { RelatoriosService } from "./relatorios.service.js";

/**
 * Somente leitura — nenhum evento de auditoria é gerado aqui (mesmo
 * critério de `DashboardController`: auditoria cobre operações
 * administrativas, não consultas).
 */
@ApiTags("Relatórios")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("relatorios")
export class RelatoriosController {
  constructor(private readonly relatoriosService: RelatoriosService) {}

  @Get("resumo")
  @ApiOperation({ summary: "Indicadores consolidados de catálogo e estoque para a tela de Relatórios." })
  async resumo() {
    return { data: await this.relatoriosService.resumo() };
  }
}
