import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
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

  /**
   * Etapa 13.2 — contrato DUPLO retrocompatível, decidido pela presença de
   * QUALQUER query param na requisição bruta (`request.query`, lido ANTES da
   * transformação do `ValidationPipe`, que sempre preenche `page`/`limit`/
   * `ordenarPor`/`ordem` com seus defaults mesmo quando o chamador não
   * enviou nada — por isso o DTO já transformado não serve para decidir
   * isto):
   *
   * - `GET /clientes` (zero query params) → contrato LEGADO do Backoffice
   *   (`clientesApi.listar()`, que nunca envia parâmetro nenhum e espera o
   *   array COMPLETO de clientes ativos — a tela faz busca/filtro/paginação
   *   inteiramente no cliente). Ver `ClientesService.listarTodosAtivos`.
   * - QUALQUER query param presente (`page`, `limit`, `busca`, facetas…) →
   *   contrato paginado/facetado já existente, inalterado — usado hoje por
   *   `PdvClientesService` (que sempre envia `page`/`limit` explícitos) e
   *   disponível para uma futura paginação real do Backoffice.
   *
   * `PdvClientesService` nunca passa por este controller (rota própria,
   * `/pdv/clientes`, chama `ClientesService.listar` diretamente) — este
   * branch não o afeta de forma alguma, mesmo sem essa garantia adicional.
   */
  @Get()
  @ApiOperation({ summary: "Lista clientes. Sem parâmetros: array completo (contrato legado do Backoffice). Com page/limit/busca/facetas: contrato paginado." })
  async listar(@Query() query: ListarClientesQueryDto, @Req() request: Request) {
    if (Object.keys(request.query).length === 0) {
      return { data: await this.clientesService.listarTodosAtivos() };
    }
    return this.clientesService.listar(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe de um cliente." })
  async obter(@Param("id") id: string) {
    return { data: await this.clientesService.obterPorId(id) };
  }

  @Get(":id/vendas")
  @ApiOperation({ summary: "Histórico de compras do cliente (inclui vendas canceladas)." })
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
