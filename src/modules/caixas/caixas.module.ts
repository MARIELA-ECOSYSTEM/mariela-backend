import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { CaixasController } from "./caixas.controller.js";
import { CaixasRepository } from "./caixas.repository.js";
import { CaixasService } from "./caixas.service.js";
import { MovimentosCaixaRepository } from "./movimentos-caixa.repository.js";
import { Caixa, CaixaSchema } from "./schemas/caixa.schema.js";
import { EventoCaixa, EventoCaixaSchema } from "./schemas/evento-caixa.schema.js";
import { MovimentoCaixa, MovimentoCaixaSchema } from "./schemas/movimento-caixa.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Caixa.name, schema: CaixaSchema },
      { name: MovimentoCaixa.name, schema: MovimentoCaixaSchema },
      { name: EventoCaixa.name, schema: EventoCaixaSchema },
    ]),
    SequenciasModule,
    // Reutilizado para resolver/validar `responsavelId` (Vendedor) — mesmo
    // padrão de reuso cross-módulo de `ProdutosModule` em Fornecedores/Coleções/Campanhas.
    VendedoresModule,
  ],
  controllers: [CaixasController],
  providers: [CaixasService, CaixasRepository, MovimentosCaixaRepository],
  exports: [CaixasService, CaixasRepository, MovimentosCaixaRepository],
})
export class CaixasModule {}
