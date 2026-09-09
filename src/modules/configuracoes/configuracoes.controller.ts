import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { ConfiguracoesService } from "./configuracoes.service.js";
import { AdicionarItemListaDto } from "./dto/adicionar-item-lista.dto.js";
import { AtualizarLojaDto } from "./dto/atualizar-loja.dto.js";

/**
 * Controller fino: valida (via DTO + ValidationPipe global), delega ao
 * service e devolve o resultado. Nenhuma regra de negócio aqui — mesmo padrão
 * de todo o Backoffice administrativo.
 */
@ApiTags("Configurações")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("configuracoes")
export class ConfiguracoesController {
  constructor(private readonly configuracoesService: ConfiguracoesService) {}

  @Get()
  @ApiOperation({ summary: "Configuração global da loja (singleton) — dados da loja e listas de categorias/tamanhos/cores/formas de pagamento." })
  async obter() {
    return { data: await this.configuracoesService.obter() };
  }

  @Put("loja")
  @ApiOperation({ summary: "Substitui integralmente os dados da loja." })
  async atualizarLoja(@Body() dto: AtualizarLojaDto) {
    return { data: await this.configuracoesService.atualizarLoja(dto) };
  }

  @Post(":lista")
  @ApiOperation({ summary: "Adiciona um valor a uma das listas (categorias, tamanhos, cores, formasPagamento)." })
  async adicionarItem(@Param("lista") lista: string, @Body() dto: AdicionarItemListaDto) {
    return { data: await this.configuracoesService.adicionarItem(lista, dto.valor) };
  }

  @Delete(":lista/:valor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove um valor de uma das listas." })
  async removerItem(@Param("lista") lista: string, @Param("valor") valor: string) {
    return { data: await this.configuracoesService.removerItem(lista, valor) };
  }
}
