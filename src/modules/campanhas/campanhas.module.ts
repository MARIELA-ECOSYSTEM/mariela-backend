import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { CampanhasController } from "./campanhas.controller.js";
import { CampanhasRepository } from "./campanhas.repository.js";
import { CampanhasService } from "./campanhas.service.js";
import { Campanha, CampanhaSchema } from "./schemas/campanha.schema.js";
import { EventoCampanha, EventoCampanhaSchema } from "./schemas/evento-campanha.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Campanha.name, schema: CampanhaSchema },
      { name: EventoCampanha.name, schema: EventoCampanhaSchema },
    ]),
    SequenciasModule,
    // Contagem de produtos vinculados e o bloqueio de exclusão com produtos
    // vinculados reusam `ProdutosRepository` — mesmo padrão de
    // `EstoqueModule`/`FornecedoresModule`/`ColecoesModule`, nunca acesso direto ao Mongoose de Produtos.
    ProdutosModule,
  ],
  controllers: [CampanhasController],
  providers: [CampanhasService, CampanhasRepository],
  exports: [CampanhasService, CampanhasRepository],
})
export class CampanhasModule {}
