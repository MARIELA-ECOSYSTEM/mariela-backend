import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AdquirentesService } from "./adquirentes.service.js";
import { AtualizarAdquirenteDto } from "./dto/atualizar-adquirente.dto.js";
import { CriarAdquirenteDto } from "./dto/criar-adquirente.dto.js";
import { ListarAdquirentesQueryDto } from "./dto/listar-adquirentes-query.dto.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui.
 *
 * Adquirentes é administrativo por definição — mesmo padrão de guards de
 * Produtos/Clientes/Fornecedores/Coleções. `@CurrentUser('sub')` extrai só o
 * id do usuário e é repassado explicitamente para a auditoria. O vendedor do
 * PDV nunca alcança este controller: o token dele é assinado com um segredo
 * diferente (`PDV_JWT_ACCESS_SECRET`, ver `PdvJwtAuthGuard`) e já falha na
 * verificação de assinatura do `JwtAuthGuard` (que usa o `JwtService` global,
 * assinado com `JWT_ACCESS_SECRET`) antes mesmo de chegar ao `RolesGuard`.
 */
@ApiTags("Adquirentes")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("adquirentes")
export class AdquirentesController {
  constructor(private readonly adquirentesService: AdquirentesService) {}

  @Post()
  @ApiOperation({ summary: "Cadastra uma adquirente de cartão. A tabela de tarifas é opcional na criação." })
  async criar(@Body() dto: CriarAdquirenteDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.adquirentesService.criar(dto, usuarioId) };
  }

  @Get()
  @ApiOperation({ summary: "Lista adquirentes ativas, com busca por nome e paginação." })
  async listar(@Query() query: ListarAdquirentesQueryDto) {
    return this.adquirentesService.listar(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe de uma adquirente." })
  async obter(@Param("id") id: string) {
    return { data: await this.adquirentesService.obterPorId(id) };
  }

  @Patch(":id")
  @ApiOperation({ summary: "Atualiza parcialmente os dados da adquirente. Ao enviar tabelaTarifas, ela substitui a tabela inteira." })
  async atualizar(@Param("id") id: string, @Body() dto: AtualizarAdquirenteDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.adquirentesService.atualizar(id, dto, usuarioId) };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove a adquirente (soft delete — o histórico é preservado)." })
  async excluir(@Param("id") id: string, @CurrentUser("sub") usuarioId: string) {
    await this.adquirentesService.excluir(id, usuarioId);
    return { data: { id } };
  }
}
