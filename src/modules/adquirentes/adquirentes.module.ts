import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AdquirentesController } from "./adquirentes.controller.js";
import { AdquirentesRepository } from "./adquirentes.repository.js";
import { AdquirentesService } from "./adquirentes.service.js";
import { Adquirente, AdquirenteSchema } from "./schemas/adquirente.schema.js";
import { EventoAdquirente, EventoAdquirenteSchema } from "./schemas/evento-adquirente.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Adquirente.name, schema: AdquirenteSchema },
      { name: EventoAdquirente.name, schema: EventoAdquirenteSchema },
    ]),
  ],
  controllers: [AdquirentesController],
  providers: [AdquirentesService, AdquirentesRepository],
  exports: [AdquirentesService, AdquirentesRepository],
})
export class AdquirentesModule {}
