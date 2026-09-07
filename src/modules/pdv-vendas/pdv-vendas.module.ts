import { Module } from "@nestjs/common";
import { CaixasModule } from "../caixas/caixas.module.js";
import { PdvAuthModule } from "../pdv-auth/pdv-auth.module.js";
import { VendasModule } from "../vendas/vendas.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { PdvVendasController } from "./pdv-vendas.controller.js";
import { PdvVendasService } from "./pdv-vendas.service.js";

/**
 * Não cria nenhuma collection nem schema novo: reutiliza integralmente
 * `vendas` (via `VendasModule` → `VendasService.criar`, que já orquestra
 * Produtos/Caixa/Cliente/Vendedor/auditoria internamente). `CaixasModule` é
 * importado à parte só para `CaixasService.obterAtual()` (`VendasModule` não
 * reexporta `CaixasService`). Direção de dependência sempre
 * `PdvVendas → Vendas`, nunca o inverso — `VendasModule` não conhece nem
 * importa nada deste módulo.
 *
 * `VendedoresModule` é importado explicitamente pelo mesmo motivo já
 * documentado em `pdv-caixa.module.ts`/`pdv-produtos.module.ts`:
 * `PdvJwtAuthGuard` depende de `VendedoresRepository`, resolvido no escopo do
 * módulo que o consome.
 */
@Module({
  imports: [PdvAuthModule, VendasModule, CaixasModule, VendedoresModule],
  controllers: [PdvVendasController],
  providers: [PdvVendasService],
})
export class PdvVendasModule {}
