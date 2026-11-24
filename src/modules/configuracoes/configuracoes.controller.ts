import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { ConfiguracoesService } from "./configuracoes.service.js";
import { AdicionarItemListaDto } from "./dto/adicionar-item-lista.dto.js";
import { AtualizarLojaDto } from "./dto/atualizar-loja.dto.js";
import { SalvarMensagemWhatsappDto } from "./dto/salvar-mensagem-whatsapp.dto.js";

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
  async atualizarLoja(@Body() dto: AtualizarLojaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.configuracoesService.atualizarLoja(dto, usuarioId) };
  }

  // Fase 22.8.9.10.7.3 — mensagens padrão de WhatsApp (caminho de 2–3 segmentos: nunca colide com `:lista`).
  @Post("whatsapp/mensagens-padrao")
  @ApiOperation({ summary: "Cria uma mensagem padrão de WhatsApp (texto de apoio; não é template da Meta)." })
  async criarMensagemWhatsapp(@Body() dto: SalvarMensagemWhatsappDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.configuracoesService.criarMensagemWhatsapp(dto, usuarioId) };
  }

  @Put("whatsapp/mensagens-padrao/:id")
  @ApiOperation({ summary: "Edita título e texto de uma mensagem padrão de WhatsApp." })
  async atualizarMensagemWhatsapp(
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body() dto: SalvarMensagemWhatsappDto,
    @CurrentUser("sub") usuarioId: string,
  ) {
    return { data: await this.configuracoesService.atualizarMensagemWhatsapp(id, dto, usuarioId) };
  }

  @Delete("whatsapp/mensagens-padrao/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Exclui uma mensagem padrão de WhatsApp." })
  async excluirMensagemWhatsapp(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.configuracoesService.excluirMensagemWhatsapp(id, usuarioId) };
  }

  @Post(":lista")
  @ApiOperation({ summary: "Adiciona um valor a uma das listas (categorias, tamanhos, cores, formasPagamento)." })
  async adicionarItem(@Param("lista") lista: string, @Body() dto: AdicionarItemListaDto, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.configuracoesService.adicionarItem(lista, dto.valor, usuarioId) };
  }

  @Delete(":lista/:valor")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove um valor de uma das listas." })
  async removerItem(@Param("lista") lista: string, @Param("valor") valor: string, @CurrentUser("sub") usuarioId: string) {
    return { data: await this.configuracoesService.removerItem(lista, valor, usuarioId) };
  }
}
