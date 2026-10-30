import { forwardRef, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { CampanhasModule } from "../campanhas/campanhas.module.js";
import { ColecoesModule } from "../colecoes/colecoes.module.js";
import { ConfiguracoesModule } from "../configuracoes/configuracoes.module.js";
import { FornecedoresModule } from "../fornecedores/fornecedores.module.js";
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
    // Etapa 10.23 — correção 6.10: `ProdutosService.criar/atualizar` agora
    // valida que fornecedor/coleção/campanha referenciados existem (não
    // soft-deleted) — mesma regra já espelhada no bloqueio de exclusão
    // dessas 3 entidades ("não pode excluir com produtos vinculados"). Esses
    // 3 módulos JÁ importam `ProdutosModule` (para o mesmo tipo de consulta,
    // no sentido inverso) — daí o `forwardRef`: uma dependência circular
    // genuína entre módulos, resolvida da forma padrão do NestJS, sem
    // reestruturar nenhum dos módulos envolvidos.
    forwardRef(() => FornecedoresModule),
    forwardRef(() => ColecoesModule),
    forwardRef(() => CampanhasModule),
    // Fase 54.2 — `ProdutosService` passa a validar cor/tamanho contra
    // `configuracoes.cores`/`configuracoes.tamanhos` ao criar/editar
    // variantes. `ConfiguracoesModule` já importa `ProdutosModule` (Fase
    // 54.0, proteção de exclusão) — mesmo tipo de dependência circular
    // genuína já resolvida acima para Fornecedores/Coleções/Campanhas.
    forwardRef(() => ConfiguracoesModule),
  ],
  controllers: [ProdutosController],
  providers: [ProdutosService, ProdutosRepository],
  // `EstoqueModule` reusa a mesma regra de domínio (nunca acessa o Mongoose diretamente).
  exports: [ProdutosService, ProdutosRepository],
})
export class ProdutosModule {}
