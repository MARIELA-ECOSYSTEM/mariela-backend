import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { VendasService } from "./vendas.service.js";
import { BaixarParcelaDto } from "./dto/baixar-parcela.dto.js";
import { CancelamentoDto } from "./dto/cancelamento.dto.js";
import { ListarVendasQueryDto } from "./dto/listar-vendas-query.dto.js";

/**
 * Controller fino, SOMENTE CONSULTA + as duas ações administrativas já
 * previstas no contrato do Backoffice (baixa de parcela, cancelamento).
 *
 * Deliberadamente NÃO existe `POST /vendas`: a criação de venda pertence ao
 * futuro MARIELA PDV. `VendasService.criar` existe e é funcional, mas nenhuma
 * rota HTTP o expõe — ver "Decisões" no relatório final.
 */
@ApiTags("Vendas")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("vendas")
export class VendasController {
  constructor(private readonly vendasService: VendasService) {}

  @Get()
  @ApiOperation({ summary: "Lista vendas com busca, facetas, ordenação e paginação." })
  async listar(@Query() query: ListarVendasQueryDto) {
    return this.vendasService.listar(query);
  }

  @Get("estatisticas")
  @ApiOperation({ summary: "Estatísticas agregadas de faturamento, vendas em aberto e canceladas." })
  async estatisticas() {
    return { data: await this.vendasService.estatisticas() };
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe da venda: itens, pagamentos, parcelas e histórico." })
  async obter(@Param("id") id: string) {
    return { data: await this.vendasService.obterPorId(id) };
  }

  @Post(":id/parcelas/:parcelaId/baixa")
  @ApiOperation({ summary: "Registra a baixa de uma parcela em aberto — o valor recebido entra no caixa do momento." })
  async baixarParcela(
    @Param("id") id: string,
    @Param("parcelaId") parcelaId: string,
    @Body() dto: BaixarParcelaDto,
    @CurrentUser("sub") usuarioId: string,
  ) {
    return { data: await this.vendasService.baixarParcela(id, parcelaId, dto, usuarioId) };
  }

  @Post(":id/cancelamento")
  @ApiOperation({ summary: "Cancela a venda (integral) ou registra devolução parcial de itens — nunca apaga o histórico." })
  async cancelar(@Param("id") id: string, @Body() dto: CancelamentoDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.vendasService.cancelar(id, dto, usuarioId) };
  }
}
