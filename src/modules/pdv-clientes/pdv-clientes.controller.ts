import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { PdvJwtAuthGuard } from "../pdv-auth/guards/pdv-jwt-auth.guard.js";
import { ListarClientesPdvQueryDto } from "./dto/listar-clientes-pdv-query.dto.js";
import { PdvClientesService } from "./pdv-clientes.service.js";

/**
 * Namespace `/pdv/clientes` — autenticação exclusiva do MARIELA PDV
 * (`PdvJwtAuthGuard`, NUNCA `JwtAuthGuard`/`RolesGuard` do Backoffice).
 * Somente leitura: nenhuma rota aqui cria, altera ou exclui cliente — isso
 * continua exclusivo do Backoffice em `/clientes/*`. Existe apenas para o
 * vendedor localizar um cliente já cadastrado e, opcionalmente, vinculá-lo a
 * uma venda (`clienteId` em `POST /pdv/vendas`).
 */
@ApiTags("PDV — Clientes")
@ApiBearerAuth()
@UseGuards(PdvJwtAuthGuard)
@Controller("pdv/clientes")
export class PdvClientesController {
  constructor(private readonly pdvClientesService: PdvClientesService) {}

  @Get()
  @ApiOperation({ summary: "Busca de clientes para vincular a uma venda — busca (nome/telefone) e paginação server-side." })
  async listar(@Query() query: ListarClientesPdvQueryDto) {
    return this.pdvClientesService.listar(query);
  }
}
