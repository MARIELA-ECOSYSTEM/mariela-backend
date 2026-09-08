import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AdquirentesModule } from "../adquirentes/adquirentes.module.js";
import { CaixasModule } from "../caixas/caixas.module.js";
import { ClientesModule } from "../clientes/clientes.module.js";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { VendasController } from "./vendas.controller.js";
import { VendasRepository } from "./vendas.repository.js";
import { VendasService } from "./vendas.service.js";
import { EventoVenda, EventoVendaSchema } from "./schemas/evento-venda.schema.js";
import { Venda, VendaSchema } from "./schemas/venda.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Venda.name, schema: VendaSchema },
      { name: EventoVenda.name, schema: EventoVendaSchema },
    ]),
    SequenciasModule,
    // Reutilizados pelo domínio de Vendas: preço/estoque (Produtos), snapshot
    // de identidade (Clientes/Vendedores) e lançamento financeiro (Caixa) —
    // mesmo padrão de reuso cross-módulo já estabelecido nos módulos anteriores.
    ProdutosModule,
    ClientesModule,
    VendedoresModule,
    CaixasModule,
    // Consulta de adquirente/tabela de tarifas para validar pagamentos
    // estruturados (Etapa 10.4) — só leitura, nunca acesso direto ao Mongo de
    // Adquirentes a partir de Vendas (mesmo padrão de reuso cross-módulo já
    // usado para Produtos/Clientes/Vendedores/Caixa acima).
    AdquirentesModule,
  ],
  controllers: [VendasController],
  providers: [VendasService, VendasRepository],
  exports: [VendasService, VendasRepository],
})
export class VendasModule {}
