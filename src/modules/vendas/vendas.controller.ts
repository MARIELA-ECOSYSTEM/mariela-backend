import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { VendasService } from "./vendas.service.js";
import { BaixarParcelaDto } from "./dto/baixar-parcela.dto.js";
import { CancelamentoDto } from "./dto/cancelamento.dto.js";
import { ListarVendasQueryDto } from "./dto/listar-vendas-query.dto.js";
import { RegistrarRecebimentoDto } from "./dto/registrar-recebimento.dto.js";

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

  /**
   * Etapa 18.25 — contrato DUPLO retrocompatível, mesmo padrão exato já
   * aprovado/implementado em `ClientesController.listar` (13.2),
   * `FornecedoresController.listar` (14.2), `ColecoesController.listar`
   * (15.2), `CampanhasController.listar` (16.2), `VendedoresController.listar`
   * (17.2) e `CaixasController.listar` (18.2): decidido pela presença de
   * QUALQUER query param na requisição BRUTA (`request.query`, lido ANTES do
   * `ValidationPipe` preencher os defaults do DTO).
   *
   * - `GET /vendas` (zero query params) → contrato LEGADO do Backoffice
   *   (`vendasApi.listar()`, que nunca envia parâmetro nenhum e espera o
   *   array COMPLETO de vendas — a tela faz busca/filtro/paginação
   *   inteiramente no cliente). Ver `VendasService.listarTodas`. Antes desta
   *   etapa, `VendasController` era o único controller do domínio sem esse
   *   fallback — vendas além das 20 primeiras (limite padrão de `listar()`)
   *   ficavam silenciosamente de fora da tela.
   * - QUALQUER query param presente (`page`, `limit`, `busca`, facetas…) →
   *   contrato paginado/facetado já existente, inalterado.
   */
  @Get()
  @ApiOperation({ summary: "Lista vendas. Sem parâmetros: array completo (contrato legado do Backoffice). Com page/limit/busca/facetas: contrato paginado." })
  async listar(@Query() query: ListarVendasQueryDto, @Req() request: Request) {
    if (Object.keys(request.query).length === 0) {
      return { data: await this.vendasService.listarTodas() };
    }
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

  @Post(":id/recebimentos")
  @ApiOperation({ summary: "Registra um recebimento posterior contra o saldo pendente de uma venda EM_PAGAMENTO." })
  async receberPagamento(@Param("id") id: string, @Body() dto: RegistrarRecebimentoDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.vendasService.receberPagamento(id, dto, usuarioId) };
  }

  @Post(":id/cancelamento")
  @ApiOperation({ summary: "Cancela a venda (integral) ou registra devolução parcial de itens — nunca apaga o histórico." })
  async cancelar(@Param("id") id: string, @Body() dto: CancelamentoDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.vendasService.cancelar(id, dto, usuarioId) };
  }
}
