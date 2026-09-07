import { Module } from "@nestjs/common";
import { ClientesModule } from "../clientes/clientes.module.js";
import { PdvAuthModule } from "../pdv-auth/pdv-auth.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { PdvClientesController } from "./pdv-clientes.controller.js";
import { PdvClientesService } from "./pdv-clientes.service.js";

/**
 * Não cria nenhuma collection nem schema novo: reutiliza integralmente
 * `clientes` através de `ClientesModule` (mesma instância de `ClientesService`
 * usada pelo Backoffice).
 *
 * `PdvAuthModule` disponibiliza `PdvJwtAuthGuard`. `VendedoresModule` é
 * importado EXPLICITAMENTE também (mesmo motivo já documentado em
 * `pdv-caixa.module.ts`/`pdv-produtos.module.ts`): o Nest resolve as
 * dependências de um guard usado via `@UseGuards()` no escopo do módulo que o
 * CONSOME, e `PdvJwtAuthGuard` depende de `VendedoresRepository`.
 */
@Module({
  imports: [PdvAuthModule, ClientesModule, VendedoresModule],
  controllers: [PdvClientesController],
  providers: [PdvClientesService],
})
export class PdvClientesModule {}
