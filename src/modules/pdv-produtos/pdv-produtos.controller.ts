import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { PdvJwtAuthGuard } from "../pdv-auth/guards/pdv-jwt-auth.guard.js";
import { ListarProdutosPdvQueryDto } from "./dto/listar-produtos-pdv-query.dto.js";
import { PdvProdutosService } from "./pdv-produtos.service.js";

/**
 * Namespace `/pdv/produtos` — autenticação exclusiva do MARIELA PDV
 * (`PdvJwtAuthGuard`, NUNCA `JwtAuthGuard`/`RolesGuard` do Backoffice).
 * Somente leitura: nenhuma rota aqui cria, altera ou exclui produto/estoque —
 * isso continua exclusivo do Backoffice em `/produtos/*`.
 */
@ApiTags("PDV — Produtos")
@ApiBearerAuth()
@UseGuards(PdvJwtAuthGuard)
@Controller("pdv/produtos")
export class PdvProdutosController {
  constructor(private readonly pdvProdutosService: PdvProdutosService) {}

  @Get()
  @ApiOperation({ summary: "Catálogo de produtos para venda — busca, ordenação e paginação server-side." })
  async listar(@Query() query: ListarProdutosPdvQueryDto) {
    return this.pdvProdutosService.listar(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Produto para venda: preço efetivo e estoque por variante/tamanho. 404 se inexistente ou excluído." })
  async obter(@Param("id") id: string) {
    return { data: await this.pdvProdutosService.obterPorId(id) };
  }
}
