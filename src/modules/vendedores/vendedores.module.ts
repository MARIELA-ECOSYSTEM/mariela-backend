import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { Venda, VendaSchema } from "../vendas/schemas/venda.schema.js";
import { VendasRepository } from "../vendas/vendas.repository.js";
import { VendedoresController } from "./vendedores.controller.js";
import { VendedoresRepository } from "./vendedores.repository.js";
import { VendedoresService } from "./vendedores.service.js";
import { Vendedor, VendedorSchema } from "./schemas/vendedor.schema.js";
import { EventoVendedor, EventoVendedorSchema } from "./schemas/evento-vendedor.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Vendedor.name, schema: VendedorSchema },
      { name: EventoVendedor.name, schema: EventoVendedorSchema },
      // `Venda` é registrada aqui (não via `VendasModule`) de propósito: `VendasModule`
      // já importa `VendedoresModule` para resolver `VendedoresRepository` — importar
      // `VendasModule` de volta aqui criaria uma dependência circular entre módulos.
      // `VendasRepository` só depende do model `Venda` (nenhuma outra dependência),
      // então registrá-lo como provider aqui, com seu próprio model registrado
      // nesta mesma injeção, reusa a MESMA classe/lógica de consulta (nunca uma
      // segunda implementação) sem inverter a direção de dependência já
      // estabelecida (Vendas depende de Vendedores, nunca o contrário) — mesmo
      // padrão já usado em `ClientesModule` (Etapa 13.2).
      { name: Venda.name, schema: VendaSchema },
    ]),
    SequenciasModule,
  ],
  controllers: [VendedoresController],
  providers: [VendedoresService, VendedoresRepository, VendasRepository],
  exports: [VendedoresService, VendedoresRepository],
})
export class VendedoresModule {}
