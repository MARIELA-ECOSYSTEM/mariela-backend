import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { EstoqueController } from "./estoque.controller.js";
import { EstoqueService } from "./estoque.service.js";
import { MovimentacaoEstoque, MovimentacaoEstoqueSchema } from "./schemas/movimentacao-estoque.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: MovimentacaoEstoque.name, schema: MovimentacaoEstoqueSchema }]),
    ProdutosModule,
  ],
  controllers: [EstoqueController],
  providers: [EstoqueService],
})
export class EstoqueModule {}
