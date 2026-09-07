import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { DashboardService } from "./dashboard.service.js";
import { ResumoDashboardQueryDto } from "./dto/resumo-dashboard-query.dto.js";

/**
 * Somente leitura — nenhum evento de auditoria é gerado aqui (ver
 * `eventos_*`): auditoria cobre operações administrativas, não consultas.
 */
@ApiTags("Dashboard")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("dashboard")
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("resumo")
  @ApiOperation({ summary: "Indicadores consolidados do Dashboard (vendas, estoque, clientes, fornecedores, vendedores)." })
  async resumo(@Query() query: ResumoDashboardQueryDto) {
    return { data: await this.dashboardService.resumo(query.mes) };
  }
}
