import { Injectable, Module, type DynamicModule } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import { MovimentosCaixaRepository } from "../modules/caixas/movimentos-caixa.repository.js";
import { MovimentoCaixa, MovimentoCaixaSchema } from "../modules/caixas/schemas/movimento-caixa.schema.js";
import { ConfiguracoesRepository } from "../modules/configuracoes/configuracoes.repository.js";
import { ConfiguracoesService } from "../modules/configuracoes/configuracoes.service.js";
import { Configuracao, ConfiguracaoSchema } from "../modules/configuracoes/schemas/configuracao.schema.js";
import { EventoConfiguracao, EventoConfiguracaoSchema } from "../modules/configuracoes/schemas/evento-configuracao.schema.js";
import { ProdutosRepository } from "../modules/produtos/produtos.repository.js";
import { Produto, ProdutoSchema } from "../modules/produtos/schemas/produto.schema.js";
import { Venda, VendaSchema } from "../modules/vendas/schemas/venda.schema.js";
import { VendasRepository } from "../modules/vendas/vendas.repository.js";

/**
 * Fase 56.4.3.1 — contexto Nest EXCLUSIVO do comando `processar-remocoes-pendentes`.
 *
 * Por que não o `AppModule` (como em `seed-admin`): inicializar a aplicação
 * escreve em índices antes de qualquer decisão do operador —
 * 1. `autoIndex`/`autoCreate` (padrão do Mongoose: ligados) fazem cada model,
 *    ao ser compilado, emitir `createIndexes`/`create`;
 * 2. `CaixasRepository.onModuleInit` e `MovimentosCaixaRepository.onModuleInit`
 *    chamam `syncIndexes()` a cada boot — que CRIA e REMOVE índices, e não é
 *    desligado por `autoIndex: false`.
 * Este módulo monta só o necessário para o `ConfiguracoesService` real
 * (mesmas classes de service/repositório, mesmos schemas) numa conexão
 * própria, com `autoIndex`/`autoCreate` desligados, e troca — SÓ neste
 * contexto — a sincronização de índices de `MovimentosCaixaRepository` por um
 * no-op. Nenhum controller (nada de guards/JWT), nenhum `CaixasRepository`.
 * A configuração global da aplicação e as conexões normais não mudam.
 */

/** `MovimentosCaixaRepository` com as MESMAS consultas, sem o `syncIndexes()` de inicialização. */
@Injectable()
export class MovimentosCaixaRepositorySemSincronizacaoDeIndices extends MovimentosCaixaRepository {
  override async onModuleInit(): Promise<void> {
    // Intencionalmente vazio: o comando nunca cria nem remove índices.
  }
}

/** Opções da conexão do comando (repassadas ao driver pelo Mongoose). */
export const OPCOES_DE_CONEXAO_DO_COMANDO = {
  autoIndex: false,
  autoCreate: false,
  serverSelectionTimeoutMS: 5_000,
  /** Identifica as operações do comando nos logs/profiler do servidor. */
  appName: "mariela-recuperacao-remocoes",
  /** Habilita os eventos de monitoramento de comandos do driver (sem ouvinte, não fazem nada). */
  monitorCommands: true,
} as const;

@Module({})
export class ComandoRemocoesPendentesModule {
  /**
   * `aoConectar` recebe a conexão logo depois de aberta e ANTES de qualquer
   * model ser compilado (ponto de instrumentação: `debug` do Mongoose,
   * monitoramento de comandos do driver).
   */
  static paraUri(uri: string, aoConectar?: (conexao: Connection) => void): DynamicModule {
    return {
      module: ComandoRemocoesPendentesModule,
      imports: [
        MongooseModule.forRoot(uri, {
          ...OPCOES_DE_CONEXAO_DO_COMANDO,
          connectionFactory: (conexao: Connection) => {
            aoConectar?.(conexao);
            return conexao;
          },
        }),
        MongooseModule.forFeature([
          { name: Configuracao.name, schema: ConfiguracaoSchema },
          { name: EventoConfiguracao.name, schema: EventoConfiguracaoSchema },
          { name: Produto.name, schema: ProdutoSchema },
          { name: Venda.name, schema: VendaSchema },
          { name: MovimentoCaixa.name, schema: MovimentoCaixaSchema },
        ]),
      ],
      providers: [
        ConfiguracoesService,
        ConfiguracoesRepository,
        ProdutosRepository,
        VendasRepository,
        { provide: MovimentosCaixaRepository, useClass: MovimentosCaixaRepositorySemSincronizacaoDeIndices },
      ],
    };
  }
}
