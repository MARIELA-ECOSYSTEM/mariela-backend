import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { IntegracoesService } from "./integracoes.service.js";

/** Somente leitura: catálogo estático (ver `IntegracoesService`). */
@ApiTags("Integrações")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("integracoes")
export class IntegracoesController {
  constructor(private readonly integracoesService: IntegracoesService) {}

  @Get()
  @ApiOperation({ summary: "Catálogo de integrações do ecossistema MARIELA." })
  listar() {
    return { data: this.integracoesService.listar() };
  }
}
