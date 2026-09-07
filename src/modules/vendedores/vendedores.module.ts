import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
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
    ]),
    SequenciasModule,
  ],
  controllers: [VendedoresController],
  providers: [VendedoresService, VendedoresRepository],
  exports: [VendedoresService, VendedoresRepository],
})
export class VendedoresModule {}
