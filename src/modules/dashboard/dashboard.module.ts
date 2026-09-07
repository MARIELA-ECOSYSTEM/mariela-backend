import { Module } from "@nestjs/common";
import { ClientesModule } from "../clientes/clientes.module.js";
import { FornecedoresModule } from "../fornecedores/fornecedores.module.js";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { VendasModule } from "../vendas/vendas.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardService } from "./dashboard.service.js";

/**
 * Não possui schema/collection própria: agrega dados já persistidos pelos
 * demais módulos (só leitura, sem escrita nenhuma). `VendasModule` já reexporta
 * `ProdutosModule`/`ClientesModule`/`VendedoresModule`, mas cada um é importado
 * aqui explicitamente para deixar clara a dependência real do Dashboard.
 */
@Module({
  imports: [VendasModule, ProdutosModule, ClientesModule, FornecedoresModule, VendedoresModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
