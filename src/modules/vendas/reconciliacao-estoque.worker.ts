import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { ReconciliacaoEstoqueConfig } from "../../config/configuration.js";
import { RECONCILIACAO_ESTOQUE_CONFIG } from "./reconciliacao-estoque.config.js";
import { descreverFalhaDeRestauracao } from "./restauracao-estoque.util.js";
import { VendasService, type ResultadoCicloReconciliacao } from "./vendas.service.js";

/**
 * Fase 60.4.3.4.18 — reconciliação AUTOMÁTICA e persistente do estoque de cancelamentos/devoluções.
 *
 * - Sem estado próprio: cada ciclo descobre as pendências NO BANCO (`VendasService.reconciliarAutomaticamente`) —
 *   sobrevive a restart/deploy e não depende de nenhum `Map` em memória.
 * - Várias instâncias podem rodar ao mesmo tempo: a exclusão mútua real está na transação por linha (ver
 *   `VendasService.restaurarLinha`); duas instâncias na mesma linha resultam em UMA devolução.
 * - Sem dependência nova (`@nestjs/schedule` não é usado no projeto): `setInterval` com `unref()` — nunca segura o
 *   processo vivo — e trava de reentrância — um ciclo lento nunca se sobrepõe ao seguinte NA MESMA instância.
 * - Iniciado em `onApplicationBootstrap` (só quando a aplicação sobe por completo; `Test.compile()` não dispara) e
 *   parado em `onModuleDestroy`. Fase 60.4.3.4.18.3 — DESLIGADO por padrão: só `RECONCILIACAO_ESTOQUE_HABILITADA=true`
 *   liga. Desligado, não cria timer, não roda ciclo imediato nem posterior — só registra que está desabilitado.
 * - O primeiro ciclo roda depois de `intervaloMs` (nunca no boot).
 */
@Injectable()
export class ReconciliacaoEstoqueWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliacaoEstoqueWorker.name);
  private temporizador: ReturnType<typeof setInterval> | null = null;
  private cicloEmAndamento: Promise<ResultadoCicloReconciliacao | null> | null = null;

  constructor(
    private readonly vendasService: VendasService,
    @Inject(RECONCILIACAO_ESTOQUE_CONFIG) private readonly config: ReconciliacaoEstoqueConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.habilitada) {
      this.logger.log(JSON.stringify({ evento: "reconciliacao_estoque.worker_desabilitado" }));
      return;
    }
    this.iniciar();
  }

  async onModuleDestroy(): Promise<void> {
    this.parar();
    // Deixa um ciclo em andamento terminar (cada linha é uma transação curta): nunca interrompe no meio de uma.
    await this.cicloEmAndamento;
  }

  /** Agenda os ciclos (idempotente). Público para os testes de integração. */
  iniciar(): void {
    if (this.temporizador) return;
    this.temporizador = setInterval(() => {
      void this.executarCiclo();
    }, this.config.intervaloMs);
    this.temporizador.unref();
    this.logger.log(
      JSON.stringify({
        evento: "reconciliacao_estoque.worker_iniciado",
        intervaloMs: this.config.intervaloMs,
        loteVendas: this.config.loteVendas,
        maxItensPorCiclo: this.config.maxItensPorCiclo,
        maxTentativas: this.config.maxTentativas,
      }),
    );
  }

  parar(): void {
    if (!this.temporizador) return;
    clearInterval(this.temporizador);
    this.temporizador = null;
  }

  get ativo(): boolean {
    return this.temporizador !== null;
  }

  /**
   * Um ciclo. Se já houver um em andamento NESTA instância, devolve a mesma promessa (nunca dois ciclos
   * simultâneos por processo). Nunca lança: erro de infraestrutura (ex.: banco indisponível) é logado e o próximo
   * ciclo tenta de novo — nada é alterado quando a descoberta falha. Devolve `null` nesse caso.
   */
  executarCiclo(): Promise<ResultadoCicloReconciliacao | null> {
    if (this.cicloEmAndamento) return this.cicloEmAndamento;
    const execucao = this.executarCicloInterno().finally(() => {
      this.cicloEmAndamento = null;
    });
    this.cicloEmAndamento = execucao;
    return execucao;
  }

  private async executarCicloInterno(): Promise<ResultadoCicloReconciliacao | null> {
    const inicio = Date.now();
    try {
      const resultado = await this.vendasService.reconciliarAutomaticamente();
      // Ciclo vazio não gera log (evita ruído a cada minuto); qualquer atividade gera uma linha de resumo.
      if (resultado.tentadas > 0 || resultado.vendasComErro > 0) {
        this.logger.log(JSON.stringify({ evento: "reconciliacao_estoque.ciclo", duracaoMs: Date.now() - inicio, ...resultado }));
      }
      return resultado;
    } catch (erro) {
      const falha = descreverFalhaDeRestauracao(erro);
      this.logger.warn(
        JSON.stringify({ evento: "reconciliacao_estoque.ciclo_falhou", duracaoMs: Date.now() - inicio, erroClasse: falha.classe, erroCodigo: falha.codigo }),
      );
      return null;
    }
  }
}
