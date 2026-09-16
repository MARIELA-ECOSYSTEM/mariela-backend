import { Module } from "@nestjs/common";
import { IntegracoesController } from "./integracoes.controller.js";
import { IntegracoesService } from "./integracoes.service.js";

@Module({
  controllers: [IntegracoesController],
  providers: [IntegracoesService],
})
export class IntegracoesModule {}
