import { forwardRef, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { FornecedoresController } from "./fornecedores.controller.js";
import { FornecedoresRepository } from "./fornecedores.repository.js";
import { FornecedoresService } from "./fornecedores.service.js";
import { EventoFornecedor, EventoFornecedorSchema } from "./schemas/evento-fornecedor.schema.js";
import { Fornecedor, FornecedorSchema } from "./schemas/fornecedor.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Fornecedor.name, schema: FornecedorSchema },
      { name: EventoFornecedor.name, schema: EventoFornecedorSchema },
    ]),
    SequenciasModule,
    // Agregados comerciais (produtosVinculados/valorEmCusto/ultimaEntrada) e o
    // bloqueio de exclusão com produtos vinculados reusam `ProdutosRepository`
    // — mesmo padrão de `EstoqueModule`, nunca acesso direto ao Mongoose de Produtos.
    //
    // Etapa 10.23 — `forwardRef`: `ProdutosModule` agora importa
    // `FornecedoresModule` de volta (validação de existência ao criar/
    // atualizar produto, correção 6.10) — dependência circular genuína,
    // resolvida da forma padrão do NestJS.
    forwardRef(() => ProdutosModule),
  ],
  controllers: [FornecedoresController],
  providers: [FornecedoresService, FornecedoresRepository],
  exports: [FornecedoresService, FornecedoresRepository],
})
export class FornecedoresModule {}
