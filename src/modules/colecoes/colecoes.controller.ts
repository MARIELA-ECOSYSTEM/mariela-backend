import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
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

  @Get()
  @ApiOperation({ summary: "Lista coleções com busca, facetas e paginação." })
  async listar(@Query() query: ListarColecoesQueryDto) {
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
