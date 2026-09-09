import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { Venda, VendaSchema } from "../vendas/schemas/venda.schema.js";
import { VendasRepository } from "../vendas/vendas.repository.js";
import { ClientesController } from "./clientes.controller.js";
import { ClientesRepository } from "./clientes.repository.js";
import { ClientesService } from "./clientes.service.js";
import { Cliente, ClienteSchema } from "./schemas/cliente.schema.js";
import { EventoCliente, EventoClienteSchema } from "./schemas/evento-cliente.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Cliente.name, schema: ClienteSchema },
      { name: EventoCliente.name, schema: EventoClienteSchema },
      // `Venda` é registrada aqui (não via `VendasModule`) de propósito: `VendasModule`
      // já importa `ClientesModule` para resolver `ClientesRepository` — importar
      // `VendasModule` de volta aqui criaria uma dependência circular entre módulos.
      // `VendasRepository` só depende do model `Venda` (nenhuma outra dependência),
      // então registrá-lo como provider aqui, com seu próprio model registrado
      // nesta mesma injeção, reusa a MESMA classe/lógica de consulta (nunca uma
      // segunda implementação) sem inverter a direção de dependência já
      // estabelecida (Vendas depende de Clientes, nunca o contrário).
      { name: Venda.name, schema: VendaSchema },
    ]),
    SequenciasModule,
  ],
  controllers: [ClientesController],
  providers: [ClientesService, ClientesRepository, VendasRepository],
  exports: [ClientesService, ClientesRepository],
})
export class ClientesModule {}
