import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AlterarStatusCampanhaDto } from "./dto/alterar-status-campanha.dto.js";
import { AtualizarCampanhaDto } from "./dto/atualizar-campanha.dto.js";
import { CriarCampanhaDto } from "./dto/criar-campanha.dto.js";
import { ListarCampanhasQueryDto } from "./dto/listar-campanhas-query.dto.js";
import { CampanhasService } from "./campanhas.service.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui.
 *
 * Campanhas é administrativo por definição — mesmo padrão de guards de
 * Produtos/Estoque/Clientes/Fornecedores/Coleções. `@CurrentUser('sub')`
 * extrai só o id do usuário e é repassado explicitamente para a auditoria.
 */
@ApiTags("Campanhas")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("campanhas")
export class CampanhasController {
  constructor(private readonly campanhasService: CampanhasService) {}

  @Post()
  @ApiOperation({ summary: "Cadastra uma campanha." })
  async criar(@Body() dto: CriarCampanhaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.campanhasService.criar(dto, usuarioId) };
  }

  /**
   * Etapa 16.2 — contrato DUPLO retrocompatível, mesmo padrão exato já
   * aprovado/implementado em `ClientesController.listar` (13.2),
   * `FornecedoresController.listar` (14.2) e `ColecoesController.listar`
   * (15.2): decidido pela presença de QUALQUER query param na requisição
   * BRUTA (`request.query`, lido ANTES do `ValidationPipe` preencher os
   * defaults do DTO — o DTO já transformado sempre tem
   * `page`/`limit`/`ordenarPor`/`ordem` preenchidos, mesmo sem o chamador
   * ter enviado nada, então não serve para decidir isto).
   *
   * - `GET /campanhas` (zero query params) → contrato LEGADO do Backoffice
   *   (`campanhasApi.listar()`, que nunca envia parâmetro nenhum e espera o
   *   array COMPLETO de campanhas ativas — a tela faz busca/filtro/
   *   paginação inteiramente no cliente). Ver `CampanhasService.listarTodosAtivos`.
   * - QUALQUER query param presente (`page`, `limit`, `busca`, facetas…) →
   *   contrato paginado/facetado já existente, inalterado.
   */
  @Get()
  @ApiOperation({ summary: "Lista campanhas. Sem parâmetros: array completo (contrato legado do Backoffice). Com page/limit/busca/facetas: contrato paginado." })
  async listar(@Query() query: ListarCampanhasQueryDto, @Req() request: Request) {
    if (Object.keys(request.query).length === 0) {
      return { data: await this.campanhasService.listarTodosAtivos() };
    }
    return this.campanhasService.listar(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe de uma campanha." })
  async obter(@Param("id") id: string) {
    return { data: await this.campanhasService.obterPorId(id) };
  }

  @Get(":id/produtos")
  @ApiOperation({ summary: "Produtos atualmente vinculados a esta campanha." })
  async listarProdutos(@Param("id") id: string) {
    const itens = await this.campanhasService.listarProdutos(id);
    return { data: itens, meta: { total: itens.length } };
  }

  @Put(":id")
  @ApiOperation({ summary: "Atualiza os dados da campanha (substituição completa)." })
  async atualizar(@Param("id") id: string, @Body() dto: AtualizarCampanhaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.campanhasService.atualizar(id, dto, usuarioId) };
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "Ativa ou inativa a campanha." })
  async alterarStatus(@Param("id") id: string, @Body() dto: AlterarStatusCampanhaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.campanhasService.alterarStatus(id, dto, usuarioId) };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove a campanha (soft delete — bloqueado se houver produtos vinculados)." })
  async excluir(@Param("id") id: string, @CurrentUser("sub") usuarioId: string) {
    await this.campanhasService.excluir(id, usuarioId);
    return { data: { id } };
  }
}
