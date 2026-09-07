import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Sequencia, SequenciaSchema } from "./schemas/sequencia.schema.js";
import { SequenciasRepository } from "./sequencias.repository.js";
import { SequenciasService } from "./sequencias.service.js";

@Module({
  imports: [MongooseModule.forFeature([{ name: Sequencia.name, schema: SequenciaSchema }])],
  providers: [SequenciasRepository, SequenciasService],
  exports: [SequenciasService],
})
export class SequenciasModule {}
