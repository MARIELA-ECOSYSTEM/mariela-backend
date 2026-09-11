import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CaixasService } from "./caixas.service.js";
import { AbrirCaixaDto } from "./dto/abrir-caixa.dto.js";
import { EntradaCaixaDto } from "./dto/entrada-caixa.dto.js";
import { FechamentoCaixaDto } from "./dto/fechamento-caixa.dto.js";
import { ListarCaixasQueryDto } from "./dto/listar-caixas-query.dto.js";
import { ListarMovimentosQueryDto } from "./dto/listar-movimentos-query.dto.js";
import { SaidaCaixaDto } from "./dto/saida-caixa.dto.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui.
 *
 * Caixa é o CAIXA GERAL DA LOJA (Etapa 18.2) — administrado exclusivamente
 * pelo ADMIN via Backoffice; abertura/injeção/sangria/fechamento não têm
 * vínculo de vendedor. `@CurrentUser('sub')` extrai o id do ADMIN
 * autenticado e é repassado explicitamente para a auditoria.
 *
 * IMPORTANTE: `atual`/`estatisticas` são declaradas ANTES de `:id` — a mesma
 * ordem importa aqui que já importava no mock (`registerCaixasMocks`), senão
 * o Nest tentaria casar "atual"/"estatisticas" como um `:id`.
 */
@ApiTags("Caixas")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("caixas")
export class CaixasController {
  constructor(private readonly caixasService: CaixasService) {}

  @Post()
  @ApiOperation({ summary: "Abre um novo caixa (só é permitido quando não há nenhum outro aberto)." })
  async abrir(@Body() dto: AbrirCaixaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.caixasService.abrir(dto, usuarioId) };
  }

  /**
   * Etapa 18.2 — contrato DUPLO retrocompatível, mesmo padrão exato já
   * aprovado/implementado em `ClientesController.listar` (13.2),
   * `FornecedoresController.listar` (14.2), `ColecoesController.listar`
   * (15.2), `CampanhasController.listar` (16.2) e `VendedoresController.listar`
   * (17.2): decidido pela presença de QUALQUER query param na requisição
   * BRUTA (`request.query`, lido ANTES do `ValidationPipe` preencher os
   * defaults do DTO).
   *
   * - `GET /caixas` (zero query params) → contrato LEGADO do Backoffice
   *   (`caixasApi.listar()`, que nunca envia parâmetro nenhum e espera o
   *   array COMPLETO de caixas — a tela faz busca/filtro/paginação
   *   inteiramente no cliente). Ver `CaixasService.listarTodos`.
   * - QUALQUER query param presente (`page`, `limit`, `busca`, facetas…) →
   *   contrato paginado/facetado já existente, inalterado.
   */
  @Get()
  @ApiOperation({ summary: "Lista caixas. Sem parâmetros: array completo (contrato legado do Backoffice). Com page/limit/busca/facetas: contrato paginado." })
  async listar(@Query() query: ListarCaixasQueryDto, @Req() request: Request) {
    if (Object.keys(request.query).length === 0) {
      return { data: await this.caixasService.listarTodos() };
    }
    return this.caixasService.listar(query);
  }

  @Get("atual")
  @ApiOperation({ summary: "Caixa aberto no momento, ou null quando nenhum está aberto." })
  async atual() {
    return { data: await this.caixasService.obterAtual() };
  }

  @Get("estatisticas")
  @ApiOperation({ summary: "Estatísticas agregadas do dia e do histórico de caixas." })
  async estatisticas() {
    return { data: await this.caixasService.estatisticas() };
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe do caixa: resumo financeiro, movimentações recentes e vendas vinculadas." })
  async obter(@Param("id") id: string) {
    return { data: await this.caixasService.obterDetalhe(id) };
  }

  /**
   * Etapa 20.01A — contrato DUPLO decidido pela presença explícita de `page`
   * OU `limit` na query BRUTA (`request.query`, lida ANTES do
   * `ValidationPipe` preencher os defaults do DTO):
   *
   * - SEM `page`/`limit` → contrato LEGADO do Backoffice (`caixasApi
   *   .movimentacoes(id)`, que nunca envia parâmetro nenhum e espera o
   *   histórico COMPLETO do caixa — a tela não pagina). `tipo`/`ordem`
   *   continuam aplicados normalmente.
   * - `page` OU `limit` presentes → contrato paginado já existente, inalterado.
   */
  @Get(":id/movimentacoes")
  @ApiOperation({
    summary:
      "Histórico de movimentações do caixa. Sem page/limit: todas (contrato legado do Backoffice). Com page/limit: paginado.",
  })
  async movimentacoes(@Param("id") id: string, @Query() query: ListarMovimentosQueryDto, @Req() request: Request) {
    const paginado = "page" in request.query || "limit" in request.query;
    return this.caixasService.listarMovimentos(id, query, paginado);
  }

  @Post(":id/entrada")
  @ApiOperation({ summary: "Registra uma injeção (entrada manual) no caixa aberto." })
  async entrada(@Param("id") id: string, @Body() dto: EntradaCaixaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.caixasService.registrarMovimento(id, "entrada", dto, usuarioId) };
  }

  @Post(":id/saida")
  @ApiOperation({ summary: "Registra uma sangria (saída manual) no caixa aberto. Pode deixar o saldo negativo." })
  async saida(@Param("id") id: string, @Body() dto: SaidaCaixaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.caixasService.registrarMovimento(id, "saida", dto, usuarioId) };
  }

  @Post(":id/fechamento")
  @ApiOperation({ summary: "Fecha o caixa: recalcula o saldo esperado e registra a diferença de conferência. Permite saldo negativo." })
  async fechar(@Param("id") id: string, @Body() dto: FechamentoCaixaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.caixasService.fechar(id, dto, usuarioId) };
  }
}
