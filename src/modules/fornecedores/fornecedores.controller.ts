import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AtualizarFornecedorDto } from "./dto/atualizar-fornecedor.dto.js";
import { CriarFornecedorDto } from "./dto/criar-fornecedor.dto.js";
import { ListarFornecedoresQueryDto } from "./dto/listar-fornecedores-query.dto.js";
import { FornecedoresService } from "./fornecedores.service.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui.
 *
 * Fornecedores é administrativo por definição — mesmo padrão de guards de
 * Produtos/Estoque/Clientes. `@CurrentUser('sub')` extrai só o id do usuário
 * e é repassado explicitamente para a auditoria.
 */
@ApiTags("Fornecedores")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("fornecedores")
export class FornecedoresController {
  constructor(private readonly fornecedoresService: FornecedoresService) {}

  @Post()
  @ApiOperation({ summary: "Cadastra um fornecedor." })
  async criar(@Body() dto: CriarFornecedorDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.fornecedoresService.criar(dto, usuarioId) };
  }

  /**
   * Etapa 14.2 — contrato DUPLO retrocompatível, mesmo padrão exato já
   * aprovado/implementado em `ClientesController.listar` (Etapa 13.2):
   * decidido pela presença de QUALQUER query param na requisição BRUTA
   * (`request.query`, lido ANTES do `ValidationPipe` preencher os defaults
   * do DTO — o DTO já transformado sempre tem `page`/`limit`/`ordenarPor`/
   * `ordem` preenchidos, mesmo sem o chamador ter enviado nada, então não
   * serve para decidir isto).
   *
   * - `GET /fornecedores` (zero query params) → contrato LEGADO do
   *   Backoffice (`fornecedoresApi.listar()`, que nunca envia parâmetro
   *   nenhum e espera o array COMPLETO de fornecedores ativos — a tela faz
   *   busca/filtro/paginação inteiramente no cliente). Ver
   *   `FornecedoresService.listarTodosAtivos`.
   * - QUALQUER query param presente (`page`, `limit`, `busca`, facetas…) →
   *   contrato paginado/facetado já existente, inalterado.
   *
   * Fornecedores não tem adaptador PDV — não existe nenhum outro
   * consumidor deste endpoint a proteger além do próprio Backoffice.
   */
  @Get()
  @ApiOperation({ summary: "Lista fornecedores. Sem parâmetros: array completo (contrato legado do Backoffice). Com page/limit/busca/facetas: contrato paginado." })
  async listar(@Query() query: ListarFornecedoresQueryDto, @Req() request: Request) {
    if (Object.keys(request.query).length === 0) {
      return { data: await this.fornecedoresService.listarTodosAtivos() };
    }
    return this.fornecedoresService.listar(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe de um fornecedor." })
  async obter(@Param("id") id: string) {
    return { data: await this.fornecedoresService.obterPorId(id) };
  }

  @Get(":id/historico")
  @ApiOperation({ summary: "Produtos atualmente vinculados a este fornecedor." })
  async listarHistorico(@Param("id") id: string) {
    const itens = await this.fornecedoresService.listarHistorico(id);
    return { data: itens, meta: { total: itens.length } };
  }

  @Put(":id")
  @ApiOperation({ summary: "Atualiza os dados do fornecedor (substituição completa)." })
  async atualizar(@Param("id") id: string, @Body() dto: AtualizarFornecedorDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.fornecedoresService.atualizar(id, dto, usuarioId) };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove o fornecedor (soft delete — bloqueado se houver produtos vinculados)." })
  async excluir(@Param("id") id: string, @CurrentUser("sub") usuarioId: string) {
    await this.fornecedoresService.excluir(id, usuarioId);
    return { data: { id } };
  }
}
