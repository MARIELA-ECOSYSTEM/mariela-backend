import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { VendedoresService } from "./vendedores.service.js";
import { AlterarStatusVendedorDto } from "./dto/alterar-status-vendedor.dto.js";
import { AtualizarVendedorDto } from "./dto/atualizar-vendedor.dto.js";
import { CriarVendedorDto } from "./dto/criar-vendedor.dto.js";
import { ListarVendedoresQueryDto } from "./dto/listar-vendedores-query.dto.js";
import { RedefinirSenhaVendedorDto } from "./dto/redefinir-senha-vendedor.dto.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui.
 *
 * Vendedores é administrado exclusivamente pelo ADMIN — o vendedor cadastrado
 * aqui é uma identidade operacional do MARIELA PDV, não um usuário do
 * Backoffice, e por isso nunca é o portador de um destes guards.
 * `@CurrentUser('sub')` extrai o id do ADMIN autenticado e é repassado
 * explicitamente para a auditoria.
 */
@ApiTags("Vendedores")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("vendedores")
export class VendedoresController {
  constructor(private readonly vendedoresService: VendedoresService) {}

  @Post()
  @ApiOperation({ summary: "Cadastra um vendedor(a) do MARIELA PDV." })
  async criar(@Body() dto: CriarVendedorDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.vendedoresService.criar(dto, usuarioId) };
  }

  /**
   * Etapa 17.2 — contrato DUPLO retrocompatível, mesmo padrão exato já
   * aprovado/implementado em `ClientesController.listar` (13.2),
   * `FornecedoresController.listar` (14.2), `ColecoesController.listar`
   * (15.2) e `CampanhasController.listar` (16.2): decidido pela presença de
   * QUALQUER query param na requisição BRUTA (`request.query`, lido ANTES do
   * `ValidationPipe` preencher os defaults do DTO — o DTO já transformado
   * sempre tem `page`/`limit`/`ordenarPor`/`ordem` preenchidos, mesmo sem o
   * chamador ter enviado nada, então não serve para decidir isto).
   *
   * - `GET /vendedores` (zero query params) → contrato LEGADO do Backoffice
   *   (`vendedoresApi.listar()`, que nunca envia parâmetro nenhum e espera o
   *   array COMPLETO de vendedores ativos — a tela faz busca/filtro/
   *   paginação inteiramente no cliente). Ver `VendedoresService.listarTodosAtivos`.
   * - QUALQUER query param presente (`page`, `limit`, `busca`, facetas…) →
   *   contrato paginado/facetado já existente, inalterado.
   */
  @Get()
  @ApiOperation({ summary: "Lista vendedores. Sem parâmetros: array completo (contrato legado do Backoffice). Com page/limit/busca/facetas: contrato paginado." })
  async listar(@Query() query: ListarVendedoresQueryDto, @Req() request: Request) {
    if (Object.keys(request.query).length === 0) {
      return { data: await this.vendedoresService.listarTodosAtivos() };
    }
    return this.vendedoresService.listar(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe de um vendedor." })
  async obter(@Param("id") id: string) {
    return { data: await this.vendedoresService.obterPorId(id) };
  }

  @Get(":id/vendas")
  @ApiOperation({ summary: "Histórico de vendas do vendedor (inclui vendas canceladas)." })
  async listarVendas(@Param("id") id: string) {
    return this.vendedoresService.listarVendas(id);
  }

  @Put(":id")
  @ApiOperation({ summary: "Atualiza os dados do vendedor (substituição completa; senha opcional)." })
  async atualizar(@Param("id") id: string, @Body() dto: AtualizarVendedorDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.vendedoresService.atualizar(id, dto, usuarioId) };
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "Ativa/inativa o acesso do vendedor ao PDV." })
  async alterarStatus(@Param("id") id: string, @Body() dto: AlterarStatusVendedorDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.vendedoresService.alterarStatus(id, dto, usuarioId) };
  }

  @Patch(":id/senha")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Redefine a senha de acesso do vendedor ao PDV." })
  async redefinirSenha(@Param("id") id: string, @Body() dto: RedefinirSenhaVendedorDto, @CurrentUser("sub") usuarioId: string) {
    await this.vendedoresService.redefinirSenha(id, dto, usuarioId);
    return { data: { id } };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove o vendedor (soft delete — o histórico é preservado)." })
  async excluir(@Param("id") id: string, @CurrentUser("sub") usuarioId: string) {
    await this.vendedoresService.excluir(id, usuarioId);
    return { data: { id } };
  }
}
