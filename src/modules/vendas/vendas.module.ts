import { forwardRef, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AdquirentesModule } from "../adquirentes/adquirentes.module.js";
import { CaixasModule } from "../caixas/caixas.module.js";
import { ClientesModule } from "../clientes/clientes.module.js";
import { ConfiguracoesModule } from "../configuracoes/configuracoes.module.js";
import { ProdutosModule } from "../produtos/produtos.module.js";
import { SequenciasModule } from "../sequencias/sequencias.module.js";
import { MovimentacaoEstoque, MovimentacaoEstoqueSchema } from "../estoque/schemas/movimentacao-estoque.schema.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { VendasController } from "./vendas.controller.js";
import { VendasRepository } from "./vendas.repository.js";
import { VendasService } from "./vendas.service.js";
import { EventoVenda, EventoVendaSchema } from "./schemas/evento-venda.schema.js";
import { Venda, VendaSchema } from "./schemas/venda.schema.js";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Venda.name, schema: VendaSchema },
      { name: EventoVenda.name, schema: EventoVendaSchema },
      // Fase 60.4.3.4.15 (F04) — ledger de estoque gravado na mesma transação da venda/restauração.
      { name: MovimentacaoEstoque.name, schema: MovimentacaoEstoqueSchema },
    ]),
    SequenciasModule,
    // Reutilizados pelo domínio de Vendas: preço/estoque (Produtos), snapshot
    // de identidade (Clientes/Vendedores) e lançamento financeiro (Caixa) —
    // mesmo padrão de reuso cross-módulo já estabelecido nos módulos anteriores.
    // Fase 55.3.2 — `forwardRef`: desde a Fase 55.2, `ProdutosModule →
    // ConfiguracoesModule → VendasModule → ProdutosModule` é um ciclo de import
    // ESM. As duas outras arestas já usam `forwardRef`; esta, direta, falhava
    // ("Cannot access 'ProdutosModule' before initialization") sempre que o
    // ponto de entrada carregava `ProdutosModule` antes de `VendasModule` (ex.:
    // `fornecedores.service.spec.ts` isolado). Só adia a avaliação da
    // referência — mesmas instâncias de providers, mesmo grafo do NestJS.
    forwardRef(() => ProdutosModule),
    ClientesModule,
    VendedoresModule,
    // Fase 55.2 — `forwardRef`: `CaixasModule` passou a fazer parte de um
    // ciclo de TRÊS módulos (`VendasModule → CaixasModule →
    // ConfiguracoesModule → VendasModule`, ver `forwardRef(() => ConfiguracoesModule)`
    // abaixo) — sem isto, o import ESM simples de `CaixasModule` neste
    // arquivo falha em tempo de carregamento ("Cannot access 'CaixasModule'
    // before initialization"), porque o ciclo de 3 nunca termina de avaliar
    // nenhuma das três classes antes de todas precisarem umas das outras.
    forwardRef(() => CaixasModule),
    // Consulta de adquirente/tabela de tarifas para validar pagamentos
    // estruturados (Etapa 10.4) — só leitura, nunca acesso direto ao Mongo de
    // Adquirentes a partir de Vendas (mesmo padrão de reuso cross-módulo já
    // usado para Produtos/Clientes/Vendedores/Caixa acima).
    AdquirentesModule,
    // Fase 55.2 — validar `forma` contra `configuracoes.formasPagamento` ao
    // criar/baixar parcela/receber pagamento. `forwardRef`: `ConfiguracoesModule`
    // importa `VendasModule` de volta (para reusar `VendasRepository` na
    // checagem de vínculo na exclusão, sem duplicar a classe) — dependência
    // circular genuína, resolvida da forma padrão do NestJS, mesmo princípio
    // já usado entre Produtos e Configuracoes desde a Fase 54.2.
    forwardRef(() => ConfiguracoesModule),
  ],
  controllers: [VendasController],
  providers: [VendasService, VendasRepository],
  exports: [VendasService, VendasRepository],
})
export class VendasModule {}
