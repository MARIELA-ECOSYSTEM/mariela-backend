import { forwardRef, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { CaixasModule } from "../caixas/caixas.module.js";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { VendasModule } from "../vendas/vendas.module.js";
import { ConfiguracoesController } from "./configuracoes.controller.js";
import { ConfiguracoesRepository } from "./configuracoes.repository.js";
import { ConfiguracoesService } from "./configuracoes.service.js";
import { Configuracao, ConfiguracaoSchema } from "./schemas/configuracao.schema.js";
import { EventoConfiguracao, EventoConfiguracaoSchema } from "./schemas/evento-configuracao.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Configuracao.name, schema: ConfiguracaoSchema },
      { name: EventoConfiguracao.name, schema: EventoConfiguracaoSchema },
    ]),
    // Fase 54.0 — checagem de vínculo antes de excluir cores/tamanhos
    // reutiliza `ProdutosRepository.listarTodosAtivos`, mesmo padrão de
    // reuso cross-módulo já estabelecido (ex.: Fornecedores/Coleções/
    // Campanhas importam ProdutosModule pelo mesmo motivo). `forwardRef`
    // desde a Fase 54.2: `ProdutosModule` passou a importar
    // `ConfiguracoesModule` também (validação de cor/tamanho ao criar
    // variante) — dependência circular genuína nos dois sentidos agora.
    forwardRef(() => ProdutosModule),
    // Fase 55.2 — checagem de vínculo antes de excluir forma de pagamento
    // reutiliza `VendasRepository`/`MovimentosCaixaRepository` JÁ exportados
    // por `VendasModule`/`CaixasModule` (nunca uma segunda implementação).
    // `forwardRef` nos dois sentidos, mesmo padrão de `ProdutosModule` acima:
    // `VendasModule`/`CaixasModule` importam `ConfiguracoesModule` de volta
    // (validação forward de forma de pagamento em `criar`/`baixarParcela`/
    // `receberPagamento`/`registrarMovimento`) — dependência circular
    // genuína nos dois sentidos.
    //
    // Primeira versão desta fase registrava `VendasRepository`/
    // `MovimentosCaixaRepository` como providers PRÓPRIOS deste módulo (com
    // seus próprios bindings de model, mesmo truque já usado por
    // `CaixasModule` para `VendasRepository` — ver o comentário lá). Essa
    // versão foi REVERTIDA: criava uma SEGUNDA instância de
    // `MovimentosCaixaRepository` (que implementa `OnModuleInit` e chama
    // `syncIndexes()`) coexistindo com a instância única de `CaixasModule`
    // dentro do MESMO grafo de DI (ex.: `PdvVendasModule → VendasModule →
    // CaixasModule` e `PdvVendasModule → VendasModule → ConfiguracoesModule
    // → [sua própria cópia]`) — duas chamadas de `syncIndexes()` concorrentes
    // contra a MESMA collection causaram instabilidade real e intermitente
    // observada em teste (conexão Mongo encerrada no meio de uma operação
    // concorrente), não apenas uma lentidão tolerável. Importar os módulos
    // via `forwardRef` em vez de duplicar os providers garante que o NestJS
    // reusa a MESMA instância singleton já existente em qualquer grafo que
    // já inclua `VendasModule`/`CaixasModule` — nunca uma segunda cópia.
    forwardRef(() => VendasModule),
    forwardRef(() => CaixasModule),
  ],
  controllers: [ConfiguracoesController],
  providers: [ConfiguracoesService, ConfiguracoesRepository],
  exports: [ConfiguracoesService, ConfiguracoesRepository],
})
export class ConfiguracoesModule {}
