import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
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

  @Get()
  @ApiOperation({ summary: "Lista campanhas com busca, facetas e paginação." })
  async listar(@Query() query: ListarCampanhasQueryDto) {
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
