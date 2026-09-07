import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
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

  @Get()
  @ApiOperation({ summary: "Lista fornecedores com busca, facetas e paginação." })
  async listar(@Query() query: ListarFornecedoresQueryDto) {
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
