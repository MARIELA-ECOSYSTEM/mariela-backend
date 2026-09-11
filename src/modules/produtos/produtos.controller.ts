import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AdicionarTamanhoDto } from "./dto/adicionar-tamanho.dto.js";
import { AtualizarProdutoDto } from "./dto/atualizar-produto.dto.js";
import { AtualizarVarianteDto } from "./dto/atualizar-variante.dto.js";
import { CriarProdutoDto } from "./dto/criar-produto.dto.js";
import { CriarVarianteDto } from "./dto/criar-variante.dto.js";
import { DefinirFotoPrincipalDto } from "./dto/definir-foto-principal.dto.js";
import { DefinirNovidadeDto } from "./dto/definir-novidade.dto.js";
import { DefinirPromocaoDto } from "./dto/definir-promocao.dto.js";
import { ListarProdutosQueryDto } from "./dto/listar-produtos-query.dto.js";
import { ProdutosService } from "./produtos.service.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui.
 *
 * Todo o controller exige um Backoffice autenticado como ADMIN — Produtos e
 * Estoque são administrativos por definição, nunca públicos. `@CurrentUser
 * ('sub')` extrai só o id do usuário (o service não precisa saber nada do
 * formato do JWT) e é repassado explicitamente para a auditoria.
 */
@ApiTags("Produtos")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("produtos")
export class ProdutosController {
  constructor(private readonly produtosService: ProdutosService) {}

  @Post()
  @ApiOperation({ summary: "Cria um produto (sem estoque nem variantes)." })
  async criar(@Body() dto: CriarProdutoDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.produtosService.criar(dto, usuarioId) };
  }

  /**
   * Etapa 20.01A — contrato DUPLO decidido pela presença explícita de `page`
   * OU `limit` na query BRUTA (`request.query`, lida ANTES do `ValidationPipe`
   * preencher os defaults do DTO) — critério mais estrito que o dos módulos
   * irmãos (`Object.keys(request.query).length === 0`) porque o Backoffice
   * SEMPRE envia `busca`/`ordenarPor`/`ordem`/facetas em `produtosApi.listar`,
   * mesmo sem filtro ativo (ver `ProdutoFiltros`), então "zero query params"
   * nunca ocorreria de fato aqui.
   *
   * - SEM `page`/`limit` → contrato LEGADO do Backoffice: busca/ordenação/
   *   facetas continuam aplicadas normalmente, mas SEM truncar por página —
   *   devolve todos os produtos que casam o filtro (a tela faz sua própria
   *   paginação local sobre o array completo). Ver `ProdutosService.listar`.
   * - `page` OU `limit` presentes → contrato paginado/facetado já existente,
   *   inalterado.
   */
  @Get()
  @ApiOperation({
    summary:
      "Lista produtos com busca e facetas. Sem page/limit: todos os itens filtrados (contrato legado do Backoffice). Com page/limit: paginado.",
  })
  async listar(@Query() query: ListarProdutosQueryDto, @Req() request: Request) {
    const paginado = "page" in request.query || "limit" in request.query;
    return this.produtosService.listar(query, paginado);
  }

  @Get(":id")
  @ApiOperation({ summary: "Detalhe de um produto." })
  async obter(@Param("id") id: string) {
    return { data: await this.produtosService.obterPorId(id) };
  }

  @Put(":id")
  @ApiOperation({ summary: "Atualiza os dados cadastrais e de preço do produto (substituição completa)." })
  async atualizar(@Param("id") id: string, @Body() dto: AtualizarProdutoDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.produtosService.atualizar(id, dto, usuarioId) };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove o produto (soft delete — o histórico é preservado)." })
  async excluir(@Param("id") id: string, @CurrentUser("sub") usuarioId: string) {
    await this.produtosService.excluir(id, usuarioId);
    return { data: { id } };
  }

  @Patch(":id/promocao")
  @ApiOperation({ summary: "Ativa ou desativa a promoção do produto." })
  async definirPromocao(
    @Param("id") id: string,
    @Body() dto: DefinirPromocaoDto,
    @CurrentUser("sub") usuarioId: string,
  ) {
    return { data: await this.produtosService.definirPromocao(id, dto, usuarioId) };
  }

  @Patch(":id/novidade")
  @ApiOperation({ summary: "Marca ou desmarca o produto como novidade." })
  async definirNovidade(
    @Param("id") id: string,
    @Body() dto: DefinirNovidadeDto,
    @CurrentUser("sub") usuarioId: string,
  ) {
    return { data: await this.produtosService.definirNovidade(id, dto, usuarioId) };
  }

  @Patch(":id/foto-principal")
  @ApiOperation({ summary: "Define qual variante fornece a foto principal do produto." })
  async definirFotoPrincipal(
    @Param("id") id: string,
    @Body() dto: DefinirFotoPrincipalDto,
    @CurrentUser("sub") usuarioId: string,
  ) {
    return { data: await this.produtosService.definirFotoPrincipal(id, dto, usuarioId) };
  }

  @Get(":id/variantes")
  @ApiOperation({ summary: "Lista as variantes do produto." })
  async listarVariantes(@Param("id") id: string) {
    const produto = await this.produtosService.obterPorId(id);
    return { data: produto.variantes };
  }

  @Post(":id/variantes")
  @ApiOperation({ summary: "Adiciona uma variante (cor) ao produto." })
  async adicionarVariante(
    @Param("id") id: string,
    @Body() dto: CriarVarianteDto,
    @CurrentUser("sub") usuarioId: string,
  ) {
    return { data: await this.produtosService.adicionarVariante(id, dto, usuarioId) };
  }

  @Put(":id/variantes/:varianteId")
  @ApiOperation({ summary: "Atualiza cor/foto/vídeo de uma variante." })
  async atualizarVariante(
    @Param("id") id: string,
    @Param("varianteId") varianteId: string,
    @Body() dto: AtualizarVarianteDto,
    @CurrentUser("sub") usuarioId: string,
  ) {
    return { data: await this.produtosService.atualizarVariante(id, varianteId, dto, usuarioId) };
  }

  @Delete(":id/variantes/:varianteId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove uma variante e seus tamanhos." })
  async removerVariante(
    @Param("id") id: string,
    @Param("varianteId") varianteId: string,
    @CurrentUser("sub") usuarioId: string,
  ) {
    await this.produtosService.removerVariante(id, varianteId, usuarioId);
    return { data: { id: varianteId } };
  }

  @Post(":id/variantes/:varianteId/tamanhos")
  @ApiOperation({ summary: "Adiciona um tamanho (com quantidade inicial) a uma variante." })
  async adicionarTamanho(
    @Param("id") id: string,
    @Param("varianteId") varianteId: string,
    @Body() dto: AdicionarTamanhoDto,
    @CurrentUser("sub") usuarioId: string,
  ) {
    return { data: await this.produtosService.adicionarTamanho(id, varianteId, dto, usuarioId) };
  }

  @Delete(":id/variantes/:varianteId/tamanhos/:tamanhoId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove um tamanho de uma variante." })
  async removerTamanho(
    @Param("id") id: string,
    @Param("varianteId") varianteId: string,
    @Param("tamanhoId") tamanhoId: string,
    @CurrentUser("sub") usuarioId: string,
  ) {
    await this.produtosService.removerTamanho(id, varianteId, tamanhoId, usuarioId);
    return { data: { id: tamanhoId } };
  }
}
