import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { ClientesService } from "./clientes.service.js";
import { AtualizarClienteDto } from "./dto/atualizar-cliente.dto.js";
import { CriarClienteDto } from "./dto/criar-cliente.dto.js";
import { ListarClientesQueryDto } from "./dto/listar-clientes-query.dto.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui.
 *
 * Clientes é administrativo por definição (o Backoffice é de uso exclusivo do
 * ADMIN) — mesmo padrão de guards de Produtos/Estoque. `@CurrentUser('sub')`
 * extrai só o id do usuário e é repassado explicitamente para a auditoria.
 */
@ApiTags("Clientes")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("clientes")
export class ClientesController {
  constructor(private readonly clientesService: ClientesService) {}

  @Post()
  @ApiOperation({ summary: "Cadastra um cliente." })
  async criar(@Body() dto: CriarClienteDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.clientesService.criar(dto, usuarioId) };
  }

  @Get()
  @ApiOperation({ summary: "Lista clientes com busca, facetas e paginação." })
  async listar(@Query() query: ListarClientesQueryDto) {
    return this.clientesService.listar(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe de um cliente." })
  async obter(@Param("id") id: string) {
    return { data: await this.clientesService.obterPorId(id) };
  }

  @Get(":id/vendas")
  @ApiOperation({ summary: "Histórico de compras do cliente (vazio até o módulo de Vendas existir)." })
  async listarVendas(@Param("id") id: string) {
    return this.clientesService.listarVendas(id);
  }

  @Put(":id")
  @ApiOperation({ summary: "Atualiza os dados do cliente (substituição completa)." })
  async atualizar(@Param("id") id: string, @Body() dto: AtualizarClienteDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.clientesService.atualizar(id, dto, usuarioId) };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove o cliente (soft delete — o histórico é preservado)." })
  async excluir(@Param("id") id: string, @CurrentUser("sub") usuarioId: string) {
    await this.clientesService.excluir(id, usuarioId);
    return { data: { id } };
  }
}
