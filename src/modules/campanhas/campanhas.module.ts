import { forwardRef, Module } from "@nestjs/common";
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
    //
    // Etapa 10.23 — `forwardRef`: `ProdutosModule` agora importa
    // `CampanhasModule` de volta (validação de existência ao criar/atualizar
    // produto, correção 6.10) — dependência circular genuína, resolvida da
    // forma padrão do NestJS.
    forwardRef(() => ProdutosModule),
  ],
  controllers: [CampanhasController],
  providers: [CampanhasService, CampanhasRepository],
  exports: [CampanhasService, CampanhasRepository],
})
export class CampanhasModule {}
