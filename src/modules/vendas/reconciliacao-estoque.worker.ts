import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { ReconciliacaoEstoqueConfig } from "../../config/configuration.js";
import { RECONCILIACAO_ESTOQUE_CONFIG } from "./reconciliacao-estoque.config.js";
import {
  categorizarErroDeCiclo,
  classificarResultadoDoCiclo,
  contadoresDoCiclo,
  emitirSeguro,
  identificarErro,
  metadadosDaPlataforma,
} from "./reconciliacao-estoque.observabilidade.js";
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
 *
 * Fase 60.4.3.4.19.5 — OBSERVABILIDADE (só logs; nenhum comportamento de reconciliação muda):
 * - `execucaoId` (um por processo/instância do worker) e `cicloId` = `${execucaoId}:${sequencial}`;
 * - todo ciclo que começa emite `ciclo_iniciado` e termina com EXATAMENTE um de `ciclo_concluido` (inclusive vazio)
 *   ou `ciclo_falhou`; um tick que encontra um ciclo em andamento não cria ciclo novo (soma em `ticksSobrepostos`);
 * - encerramento: `worker_parando` (antes de esperar o ciclo) e `worker_parado` (depois) — só em shutdown gracioso;
 * - toda emissão é protegida (`emitirSeguro`): falha de log nunca altera o resultado nem vira `ciclo_falhou`.
 */
@Injectable()
export class ReconciliacaoEstoqueWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliacaoEstoqueWorker.name);
  private temporizador: ReturnType<typeof setInterval> | null = null;
  private cicloEmAndamento: Promise<ResultadoCicloReconciliacao | null> | null = null;
  /** Fase 60.4.3.4.19.5 — identidade desta execução (gerada uma vez; nunca por ciclo). */
  readonly execucaoId: string = randomUUID();
  /** Ciclos INICIADOS por este worker (também é o sequencial do último `cicloId`). */
  private ciclosIniciados = 0;
  private ticksSobrepostosNoCiclo = 0;

  constructor(
    private readonly vendasService: VendasService,
    @Inject(RECONCILIACAO_ESTOQUE_CONFIG) private readonly config: ReconciliacaoEstoqueConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.habilitada) {
      this.emitir("log", { evento: "reconciliacao_estoque.worker_desabilitado", execucaoId: this.execucaoId });
      return;
    }
    this.iniciar();
  }

  async onModuleDestroy(): Promise<void> {
    const emAndamento = this.cicloEmAndamento;
    // Worker que nunca foi ligado nem rodou ciclo: nada a encerrar (sem eventos de ruído para o worker desabilitado).
    if (!this.temporizador && !emAndamento) return;
    this.emitir("log", { evento: "reconciliacao_estoque.worker_parando", execucaoId: this.execucaoId, cicloEmAndamento: emAndamento !== null });
    this.parar();
    // Deixa um ciclo em andamento terminar (cada linha é uma transação curta): nunca interrompe no meio de uma.
    await emAndamento;
    this.emitir("log", { evento: "reconciliacao_estoque.worker_parado", execucaoId: this.execucaoId, ciclosExecutados: this.ciclosIniciados });
  }

  /** Agenda os ciclos (idempotente). Público para os testes de integração. */
  iniciar(): void {
    if (this.temporizador) return;
    this.temporizador = setInterval(() => {
      void this.executarCiclo();
    }, this.config.intervaloMs);
    this.temporizador.unref();
    this.emitir("log", {
      evento: "reconciliacao_estoque.worker_iniciado",
      execucaoId: this.execucaoId,
      ...metadadosDaPlataforma(),
      intervaloMs: this.config.intervaloMs,
      loteVendas: this.config.loteVendas,
      maxItensPorCiclo: this.config.maxItensPorCiclo,
      maxTentativas: this.config.maxTentativas,
    });
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
   * simultâneos por processo) e só conta o tick em `ticksSobrepostos`. Nunca lança: erro de infraestrutura (ex.: banco
   * indisponível) é logado e o próximo ciclo tenta de novo — nada é alterado quando a descoberta falha. Devolve `null`
   * nesse caso.
   */
  executarCiclo(): Promise<ResultadoCicloReconciliacao | null> {
    if (this.cicloEmAndamento) {
      this.ticksSobrepostosNoCiclo += 1;
      return this.cicloEmAndamento;
    }
    const execucao = this.executarCicloInterno().finally(() => {
      this.cicloEmAndamento = null;
    });
    this.cicloEmAndamento = execucao;
    return execucao;
  }

  private async executarCicloInterno(): Promise<ResultadoCicloReconciliacao | null> {
    this.ciclosIniciados += 1;
    this.ticksSobrepostosNoCiclo = 0;
    const cicloId = `${this.execucaoId}:${this.ciclosIniciados}`;
    const inicio = Date.now();
    const iniciadoEm = new Date(inicio).toISOString();
    const identidade = { execucaoId: this.execucaoId, cicloId, iniciadoEm };
    this.emitir("log", {
      evento: "reconciliacao_estoque.ciclo_iniciado",
      ...identidade,
      intervaloMs: this.config.intervaloMs,
      loteVendas: this.config.loteVendas,
      maxItensPorCiclo: this.config.maxItensPorCiclo,
    });

    let resultado: ResultadoCicloReconciliacao;
    try {
      resultado = await this.vendasService.reconciliarAutomaticamente();
    } catch (erro) {
      const fim = Date.now();
      this.emitir("warn", {
        evento: "reconciliacao_estoque.ciclo_falhou",
        ...identidade,
        falhouEm: new Date(fim).toISOString(),
        duracaoMs: fim - inicio,
        categoriaErro: categorizarErroDeCiclo(erro),
        ...identificarErro(erro),
        // O timer continua agendado? (não promete sucesso — só que haverá nova oportunidade de ciclo).
        novaOportunidade: this.temporizador !== null,
      });
      return null;
    }

    // Fora do `try`: um problema na montagem/emissão do log nunca transforma este ciclo em `ciclo_falhou`.
    const fim = Date.now();
    try {
      const contadores = contadoresDoCiclo(resultado, this.ticksSobrepostosNoCiclo);
      const resultadoDoCiclo = classificarResultadoDoCiclo(contadores);
      this.emitir(resultadoDoCiclo === "processado_com_falhas" ? "warn" : "log", {
        evento: "reconciliacao_estoque.ciclo_concluido",
        ...identidade,
        concluidoEm: new Date(fim).toISOString(),
        duracaoMs: fim - inicio,
        ...contadores,
        resultado: resultadoDoCiclo,
      });
    } catch {
      // Intencional: observabilidade nunca altera o resultado operacional.
    }
    return resultado;
  }

  private emitir(nivel: "log" | "warn", dados: Record<string, unknown>): void {
    emitirSeguro(this.logger, nivel, dados);
  }
}
