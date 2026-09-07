import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { ColecoesController } from "./colecoes.controller.js";
import { ColecoesRepository } from "./colecoes.repository.js";
import { ColecoesService } from "./colecoes.service.js";
import { Colecao, ColecaoSchema } from "./schemas/colecao.schema.js";
import { EventoColecao, EventoColecaoSchema } from "./schemas/evento-colecao.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Colecao.name, schema: ColecaoSchema },
      { name: EventoColecao.name, schema: EventoColecaoSchema },
    ]),
    SequenciasModule,
    // Contagem de produtos vinculados e o bloqueio de exclusão com produtos
    // vinculados reusam `ProdutosRepository` — mesmo padrão de
    // `EstoqueModule`/`FornecedoresModule`, nunca acesso direto ao Mongoose de Produtos.
    ProdutosModule,
  ],
  controllers: [ColecoesController],
  providers: [ColecoesService, ColecoesRepository],
  exports: [ColecoesService, ColecoesRepository],
})
export class ColecoesModule {}
