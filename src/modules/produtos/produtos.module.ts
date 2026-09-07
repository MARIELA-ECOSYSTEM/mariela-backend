import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { ProdutosController } from "./produtos.controller.js";
import { ProdutosRepository } from "./produtos.repository.js";
import { ProdutosService } from "./produtos.service.js";
import { EventoProduto, EventoProdutoSchema } from "./schemas/evento-produto.schema.js";
import { Produto, ProdutoSchema } from "./schemas/produto.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Produto.name, schema: ProdutoSchema },
      { name: EventoProduto.name, schema: EventoProdutoSchema },
    ]),
    SequenciasModule,
  ],
  controllers: [ProdutosController],
  providers: [ProdutosService, ProdutosRepository],
  // `EstoqueModule` reusa a mesma regra de domínio (nunca acessa o Mongoose diretamente).
  exports: [ProdutosService, ProdutosRepository],
})
export class ProdutosModule {}
