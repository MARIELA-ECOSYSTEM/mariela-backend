import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CaixasService } from "./caixas.service.js";
import { AbrirCaixaDto } from "./dto/abrir-caixa.dto.js";
import { EntradaCaixaDto } from "./dto/entrada-caixa.dto.js";
import { FechamentoCaixaDto } from "./dto/fechamento-caixa.dto.js";
import { ListarCaixasQueryDto } from "./dto/listar-caixas-query.dto.js";
import { ListarMovimentosQueryDto } from "./dto/listar-movimentos-query.dto.js";
import { SaidaCaixaDto } from "./dto/saida-caixa.dto.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui.
 *
 * Caixa é administrado exclusivamente pelo ADMIN — abertura/entrada/saída/
 * fechamento são operações do Backoffice sobre o caixa físico da loja, não
 * vendas. `@CurrentUser('sub')` extrai o id do ADMIN autenticado e é
 * repassado explicitamente para a auditoria.
 *
 * IMPORTANTE: `atual`/`estatisticas` são declaradas ANTES de `:id` — a mesma
 * ordem importa aqui que já importava no mock (`registerCaixasMocks`), senão
 * o Nest tentaria casar "atual"/"estatisticas" como um `:id`.
 */
@ApiTags("Caixas")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("caixas")
export class CaixasController {
  constructor(private readonly caixasService: CaixasService) {}

  @Post()
  @ApiOperation({ summary: "Abre um novo caixa (só é permitido quando não há nenhum outro aberto)." })
  async abrir(@Body() dto: AbrirCaixaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.caixasService.abrir(dto, usuarioId) };
  }

  @Get()
  @ApiOperation({ summary: "Lista caixas com busca, facetas, ordenação e paginação." })
  async listar(@Query() query: ListarCaixasQueryDto) {
    return this.caixasService.listar(query);
  }

  @Get("atual")
  @ApiOperation({ summary: "Caixa aberto no momento, ou null quando nenhum está aberto." })
  async atual() {
    return { data: await this.caixasService.obterAtual() };
  }

  @Get("estatisticas")
  @ApiOperation({ summary: "Estatísticas agregadas do dia e do histórico de caixas." })
  async estatisticas() {
    return { data: await this.caixasService.estatisticas() };
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe do caixa: resumo financeiro e movimentações recentes." })
  async obter(@Param("id") id: string) {
    return { data: await this.caixasService.obterDetalhe(id) };
  }

  @Get(":id/movimentacoes")
  @ApiOperation({ summary: "Histórico paginado de movimentações do caixa." })
  async movimentacoes(@Param("id") id: string, @Query() query: ListarMovimentosQueryDto) {
    return this.caixasService.listarMovimentos(id, query);
  }

  @Get(":id/vendas")
  @ApiOperation({ summary: "Vendas vinculadas ao caixa (vazio até o módulo de Vendas existir)." })
  async vendas(@Param("id") id: string) {
    return this.caixasService.listarVendas(id);
  }

  @Get(":id/recebimentos")
  @ApiOperation({ summary: "Recebimentos de parcela do caixa (vazio até o módulo de Vendas existir)." })
  async recebimentos(@Param("id") id: string) {
    return this.caixasService.listarRecebimentos(id);
  }

  @Post(":id/entrada")
  @ApiOperation({ summary: "Registra uma entrada manual (suprimento/ajuste) no caixa aberto." })
  async entrada(@Param("id") id: string, @Body() dto: EntradaCaixaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.caixasService.registrarMovimento(id, "entrada", dto, usuarioId) };
  }

  @Post(":id/saida")
  @ApiOperation({ summary: "Registra uma saída manual (retirada/despesa) no caixa aberto, sem exceder o saldo." })
  async saida(@Param("id") id: string, @Body() dto: SaidaCaixaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.caixasService.registrarMovimento(id, "saida", dto, usuarioId) };
  }

  @Post(":id/fechamento")
  @ApiOperation({ summary: "Fecha o caixa: recalcula o saldo esperado e registra a diferença de conferência." })
  async fechar(@Param("id") id: string, @Body() dto: FechamentoCaixaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.caixasService.fechar(id, dto, usuarioId) };
  }
}
