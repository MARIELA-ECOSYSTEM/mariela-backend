import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Test, type TestingModule } from "@nestjs/testing";
import type { ReconciliacaoEstoqueConfig } from "../../config/configuration.js";
import { RECONCILIACAO_ESTOQUE_CONFIG } from "./reconciliacao-estoque.config.js";
import { ReconciliacaoEstoqueWorker } from "./reconciliacao-estoque.worker.js";
import { VendasService, type ResultadoCicloReconciliacao } from "./vendas.service.js";

/**
 * Fase 60.4.3.4.18.3 — ciclo de vida do `ReconciliacaoEstoqueWorker` SEM MongoDB: o `VendasService` é substituído por
 * um dublê que só conta chamadas, para provar quando um ciclo roda (ou não).
 */

const CICLO_VAZIO: ResultadoCicloReconciliacao = {
  vendas: 0,
  tentadas: 0,
  concluidas: 0,
  jaConcluidas: 0,
  falhas: 0,
  adiadas: 0,
  indeterminadas: 0,
  vendasComErro: 0,
};

function configuracao(habilitada: boolean, intervaloMs: number): ReconciliacaoEstoqueConfig {
  return { habilitada, intervaloMs, loteVendas: 20, maxItensPorCiclo: 50, maxTentativas: 8, esperaBaseMs: 30_000, esperaMaximaMs: 3_600_000 };
}

describe("ReconciliacaoEstoqueWorker — ativação (sem MongoDB)", () => {
  const abertos: TestingModule[] = [];
  const espioes: { mockRestore: () => void }[] = [];

  afterEach(async () => {
    while (espioes.length) espioes.pop()?.mockRestore();
    while (abertos.length) await abertos.pop()?.close();
  });

  async function montar(config: ReconciliacaoEstoqueConfig) {
    let ciclos = 0;
    const servicoFalso = {
      reconciliarAutomaticamente: async (): Promise<ResultadoCicloReconciliacao> => {
        ciclos += 1;
        return CICLO_VAZIO;
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [ReconciliacaoEstoqueWorker, { provide: VendasService, useValue: servicoFalso }, { provide: RECONCILIACAO_ESTOQUE_CONFIG, useValue: config }],
    }).compile();
    abertos.push(moduleRef);
    return { moduleRef, worker: moduleRef.get(ReconciliacaoEstoqueWorker), ciclos: () => ciclos };
  }

  it("DESABILITADO: o bootstrap não cria timer, não roda ciclo imediato nem posterior", async () => {
    const setIntervalEspiao = spyOn(globalThis, "setInterval");
    espioes.push(setIntervalEspiao);
    const { moduleRef, worker, ciclos } = await montar(configuracao(false, 20));

    await moduleRef.init(); // dispara `onApplicationBootstrap`, como a aplicação real
    expect(worker.ativo).toBe(false);
    expect(setIntervalEspiao).not.toHaveBeenCalled();
    expect(ciclos()).toBe(0);

    await new Promise((resolver) => setTimeout(resolver, 120)); // vários "intervalos" depois
    expect(ciclos()).toBe(0);
    expect(worker.ativo).toBe(false);
  });

  it("HABILITADO: cria um timer com o intervalo configurado, o primeiro ciclo só roda DEPOIS do intervalo, e para no shutdown", async () => {
    const setIntervalEspiao = spyOn(globalThis, "setInterval");
    espioes.push(setIntervalEspiao);
    const { moduleRef, worker, ciclos } = await montar(configuracao(true, 40));

    await moduleRef.init();
    expect(worker.ativo).toBe(true);
    expect(setIntervalEspiao).toHaveBeenCalledTimes(1);
    expect(setIntervalEspiao.mock.calls[0]?.[1]).toBe(40);
    expect(ciclos()).toBe(0); // nada roda no boot

    const limite = Date.now() + 2_000;
    while (ciclos() === 0 && Date.now() < limite) await new Promise((resolver) => setTimeout(resolver, 10));
    expect(ciclos()).toBeGreaterThanOrEqual(1);

    await moduleRef.close();
    abertos.pop();
    expect(worker.ativo).toBe(false);
    const depoisDoShutdown = ciclos();
    await new Promise((resolver) => setTimeout(resolver, 120));
    expect(ciclos()).toBe(depoisDoShutdown);
  });

  it("`iniciar()` é idempotente: chamado de novo não cria um segundo timer", async () => {
    const setIntervalEspiao = spyOn(globalThis, "setInterval");
    espioes.push(setIntervalEspiao);
    const { worker } = await montar(configuracao(true, 60_000));
    worker.iniciar();
    worker.iniciar();
    expect(setIntervalEspiao).toHaveBeenCalledTimes(1);
    worker.parar();
    expect(worker.ativo).toBe(false);
  });
});
