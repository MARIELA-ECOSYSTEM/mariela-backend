import { Module } from "@nestjs/common";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { RelatoriosController } from "./relatorios.controller.js";
import { RelatoriosService } from "./relatorios.service.js";

/** Não possui schema/collection própria: agrega dados já persistidos por Produtos (só leitura). */
@Module({
  imports: [ProdutosModule],
  controllers: [RelatoriosController],
  providers: [RelatoriosService],
})
export class RelatoriosModule {}
