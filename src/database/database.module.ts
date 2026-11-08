import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { mongooseConfigFactory } from "./mongoose.config.js";
import { VerificacaoTopologiaMongo } from "./verificacao-topologia.service.js";

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
  // Fase 60.4.3.4.15 (F04) — aviso no boot quando o MongoDB não suporta transações.
  providers: [VerificacaoTopologiaMongo],
  exports: [MongooseModule],
})
export class DatabaseModule {}
