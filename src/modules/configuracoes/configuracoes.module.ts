import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ConfiguracoesController } from "./configuracoes.controller.js";
import { ConfiguracoesRepository } from "./configuracoes.repository.js";
import { ConfiguracoesService } from "./configuracoes.service.js";
import { Configuracao, ConfiguracaoSchema } from "./schemas/configuracao.schema.js";

@Module({
  imports: [MongooseModule.forFeature([{ name: Configuracao.name, schema: ConfiguracaoSchema }])],
  controllers: [ConfiguracoesController],
  providers: [ConfiguracoesService, ConfiguracoesRepository],
  exports: [ConfiguracoesService, ConfiguracoesRepository],
})
export class ConfiguracoesModule {}
