import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { UploadMidia, UploadMidiaSchema } from "./schemas/upload-midia.schema.js";
import { UploadsMidiaRepository } from "./uploads-midia.repository.js";

/** Fase 60.1 — coleção `uploads_midia` isolada num módulo próprio: a galeria a usa agora, e a limpeza futura (60.3) poderá importá-la sem o resto da mídia. */
@Module({
  imports: [MongooseModule.forFeature([{ name: UploadMidia.name, schema: UploadMidiaSchema }])],
  providers: [UploadsMidiaRepository],
  exports: [UploadsMidiaRepository],
})
export class UploadsMidiaModule {}
