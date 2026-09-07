import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { EntradaEstoqueDto } from "./dto/entrada-estoque.dto.js";
import { ListarEstoqueQueryDto } from "./dto/listar-estoque-query.dto.js";
import { SaidaEstoqueDto } from "./dto/saida-estoque.dto.js";
import { EstoqueService } from "./estoque.service.js";

/**
 * Controller fino sobre a MESMA regra de domínio de `ProdutosService` — não
 * existe uma collection "estoque" independente (o estoque pertence ao
 * produto); isto é só uma leitura/operação especializada sobre ele.
 * Administrativo, como Produtos — exige ADMIN autenticado.
 */
@ApiTags("Estoque")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("estoque")
export class EstoqueController {
  constructor(private readonly estoqueService: EstoqueService) {}

  @Get()
  @ApiOperation({ summary: "Lista o resumo de estoque por produto (cores e tamanhos)." })
  async listar(@Query() query: ListarEstoqueQueryDto) {
    return { data: await this.estoqueService.listar(query) };
  }

  @Post("entrada")
  @ApiOperation({ summary: "Registra entrada de estoque em um tamanho (existente ou novo)." })
  async entrada(@Body() dto: EntradaEstoqueDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.estoqueService.entrada(dto, usuarioId) };
  }

  @Post("saida")
  @ApiOperation({ summary: "Registra saída de estoque (nunca deixa a quantidade negativa)." })
  async saida(@Body() dto: SaidaEstoqueDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.estoqueService.saida(dto, usuarioId) };
  }
}
