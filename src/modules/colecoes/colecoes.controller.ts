import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AlterarStatusColecaoDto } from "./dto/alterar-status-colecao.dto.js";
import { AtualizarColecaoDto } from "./dto/atualizar-colecao.dto.js";
import { CriarColecaoDto } from "./dto/criar-colecao.dto.js";
import { ListarColecoesQueryDto } from "./dto/listar-colecoes-query.dto.js";
import { ColecoesService } from "./colecoes.service.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui.
 *
 * Coleções é administrativo por definição — mesmo padrão de guards de
 * Produtos/Estoque/Clientes/Fornecedores. `@CurrentUser('sub')` extrai só o
 * id do usuário e é repassado explicitamente para a auditoria.
 */
@ApiTags("Coleções")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("colecoes")
export class ColecoesController {
  constructor(private readonly colecoesService: ColecoesService) {}

  @Post()
  @ApiOperation({ summary: "Cadastra uma coleção." })
  async criar(@Body() dto: CriarColecaoDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.colecoesService.criar(dto, usuarioId) };
  }

  /**
   * Etapa 15.2 — contrato DUPLO retrocompatível, mesmo padrão exato já
   * aprovado/implementado em `ClientesController.listar` (13.2) e
   * `FornecedoresController.listar` (14.2): decidido pela presença de
   * QUALQUER query param na requisição BRUTA (`request.query`, lido ANTES
   * do `ValidationPipe` preencher os defaults do DTO — o DTO já
   * transformado sempre tem `page`/`limit`/`ordenarPor`/`ordem`
   * preenchidos, mesmo sem o chamador ter enviado nada, então não serve
   * para decidir isto).
   *
   * - `GET /colecoes` (zero query params) → contrato LEGADO do Backoffice
   *   (`colecoesApi.listar()`, que nunca envia parâmetro nenhum e espera o
   *   array COMPLETO de coleções ativas — a tela faz busca/filtro/
   *   paginação inteiramente no cliente). Ver `ColecoesService.listarTodosAtivos`.
   * - QUALQUER query param presente (`page`, `limit`, `busca`, facetas…) →
   *   contrato paginado/facetado já existente, inalterado.
   */
  @Get()
  @ApiOperation({ summary: "Lista coleções. Sem parâmetros: array completo (contrato legado do Backoffice). Com page/limit/busca/facetas: contrato paginado." })
  async listar(@Query() query: ListarColecoesQueryDto, @Req() request: Request) {
    if (Object.keys(request.query).length === 0) {
      return { data: await this.colecoesService.listarTodosAtivos() };
    }
    return this.colecoesService.listar(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe de uma coleção." })
  async obter(@Param("id") id: string) {
    return { data: await this.colecoesService.obterPorId(id) };
  }

  @Get(":id/produtos")
  @ApiOperation({ summary: "Produtos atualmente vinculados a esta coleção." })
  async listarProdutos(@Param("id") id: string) {
    const itens = await this.colecoesService.listarProdutos(id);
    return { data: itens, meta: { total: itens.length } };
  }

  @Put(":id")
  @ApiOperation({ summary: "Atualiza os dados da coleção (substituição completa)." })
  async atualizar(@Param("id") id: string, @Body() dto: AtualizarColecaoDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.colecoesService.atualizar(id, dto, usuarioId) };
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "Ativa ou inativa a coleção." })
  async alterarStatus(@Param("id") id: string, @Body() dto: AlterarStatusColecaoDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.colecoesService.alterarStatus(id, dto, usuarioId) };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove a coleção (soft delete — bloqueado se houver produtos vinculados)." })
  async excluir(@Param("id") id: string, @CurrentUser("sub") usuarioId: string) {
    await this.colecoesService.excluir(id, usuarioId);
    return { data: { id } };
  }
}
