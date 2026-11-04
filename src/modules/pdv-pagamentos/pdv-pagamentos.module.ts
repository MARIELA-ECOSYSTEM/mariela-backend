import { Module } from "@nestjs/common";
import { AdquirentesModule } from "../adquirentes/adquirentes.module.js";
import { ConfiguracoesModule } from "../configuracoes/configuracoes.module.js";
import { PdvAuthModule } from "../pdv-auth/pdv-auth.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { PdvPagamentosController } from "./pdv-pagamentos.controller.js";
import { PdvPagamentosService } from "./pdv-pagamentos.service.js";

/**
 * Fase 59 — não cria collection nem schema: reutiliza `configuracoes` e
 * `adquirentes` pelos módulos donos (mesmas instâncias de service usadas pelo
 * Backoffice e por `VendasService`).
 *
 * `PdvAuthModule` disponibiliza `PdvJwtAuthGuard`; `VendedoresModule` é
 * importado explicitamente pelo mesmo motivo já documentado em
 * `pdv-clientes.module.ts`: o guard depende de `VendedoresRepository`, resolvido
 * no escopo do módulo que o consome.
 */
@Module({
  imports: [PdvAuthModule, VendedoresModule, AdquirentesModule, ConfiguracoesModule],
  controllers: [PdvPagamentosController],
  providers: [PdvPagamentosService],
})
export class PdvPagamentosModule {}
