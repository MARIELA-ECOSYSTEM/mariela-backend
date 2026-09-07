import { Module } from "@nestjs/common";
import { PdvAuthModule } from "../pdv-auth/pdv-auth.module.js";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { PdvProdutosController } from "./pdv-produtos.controller.js";
import { PdvProdutosService } from "./pdv-produtos.service.js";

/**
 * Não cria nenhuma collection nem schema novo: reutiliza integralmente
 * `produtos` através de `ProdutosModule` (mesma instância de `ProdutosService`
 * usada pelo Backoffice).
 *
 * `PdvAuthModule` disponibiliza `PdvJwtAuthGuard`. `VendedoresModule` é
 * importado EXPLICITAMENTE também (mesmo motivo já documentado em
 * `pdv-caixa.module.ts`): o Nest resolve as dependências de um guard usado
 * via `@UseGuards()` no escopo do módulo que o CONSOME, e `PdvJwtAuthGuard`
 * depende de `VendedoresRepository`.
 */
@Module({
  imports: [PdvAuthModule, ProdutosModule, VendedoresModule],
  controllers: [PdvProdutosController],
  providers: [PdvProdutosService],
})
export class PdvProdutosModule {}
