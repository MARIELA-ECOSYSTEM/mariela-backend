import { Module } from "@nestjs/common";
import { CaixasModule } from "../caixas/caixas.module.js";
import { PdvAuthModule } from "../pdv-auth/pdv-auth.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { PdvCaixaController } from "./pdv-caixa.controller.js";
import { PdvCaixaService } from "./pdv-caixa.service.js";

/**
 * Não cria nenhuma collection nova nem schema novo: reutiliza integralmente
 * `caixas`/`movimentos_caixa`/`eventos_caixa` através de `CaixasModule`
 * (mesma instância de `CaixasService` usada pelo Backoffice — um único
 * agregado financeiro, dois contextos de autenticação).
 *
 * `PdvAuthModule` é importado para disponibilizar `PdvJwtAuthGuard` a este
 * módulo. `VendedoresModule` é importado EXPLICITAMENTE também (não só via
 * `PdvAuthModule`): o Nest resolve as dependências de um guard usado via
 * `@UseGuards()` no escopo do módulo que o CONSOME, então `VendedoresRepository`
 * (dependência de `PdvJwtAuthGuard`) precisa estar visível diretamente aqui,
 * não apenas dentro do módulo onde o guard foi declarado.
 */
@Module({
  imports: [PdvAuthModule, CaixasModule, VendedoresModule],
  controllers: [PdvCaixaController],
  providers: [PdvCaixaService],
})
export class PdvCaixaModule {}
