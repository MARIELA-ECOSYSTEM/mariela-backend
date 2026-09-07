import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { mongooseConfigFactory } from "./mongoose.config.js";

/**
 * Único ponto de configuração da conexão com o MongoDB. Módulos de negócio
 * importam apenas `MongooseModule.forFeature([...])` para seus próprios
 * schemas — nunca configuram uma conexão própria.
 *
 * O encerramento gracioso da conexão (`connection.close()`) é feito
 * automaticamente pelo `@nestjs/mongoose` quando `app.enableShutdownHooks()`
 * está habilitado em `main.ts`.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: mongooseConfigFactory,
    }),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
