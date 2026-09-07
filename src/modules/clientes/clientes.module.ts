import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
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
    ]),
    SequenciasModule,
  ],
  controllers: [ClientesController],
  providers: [ClientesService, ClientesRepository],
  exports: [ClientesService, ClientesRepository],
})
export class ClientesModule {}
