import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Logger } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { ReconciliacaoEstoqueConfig } from "../../config/configuration.js";
import { RECONCILIACAO_ESTOQUE_CONFIG } from "./reconciliacao-estoque.config.js";
import { ReconciliacaoEstoqueWorker } from "./reconciliacao-estoque.worker.js";
import { VendasService, type ResultadoCicloReconciliacao } from "./vendas.service.js";

/**
 * Fase 60.4.3.4.18.3 — ciclo de vida do `ReconciliacaoEstoqueWorker` SEM MongoDB: o `VendasService` é substituído por
 * um dublê que só conta chamadas, para provar quando um ciclo roda (ou não).
 * Fase 60.4.3.4.19.5 — observabilidade: eventos, identidades e proteção contra falha do logger.
 */

const CICLO_VAZIO: ResultadoCicloReconciliacao = {
  vendas: 0,
  vendasConsultadas: 0,
  tentadas: 0,
  concluidas: 0,
  jaConcluidas: 0,
  falhas: 0,
  adiadas: 0,
  indeterminadas: 0,
  falhasRecuperaveis: 0,
  requeremIntervencao: 0,
  falhasNaoRegistradas: 0,
  adiadasNaTransacao: 0,
  indeterminadasNaTransacao: 0,
  vendasComErro: 0,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Nome de classe igual ao do driver — a categorização usa só classe/código/rótulos. */
class MongoServerSelectionError extends Error {}

function configuracao(habilitada: boolean, intervaloMs: number): ReconciliacaoEstoqueConfig {
  return { habilitada, intervaloMs, loteVendas: 20, maxItensPorCiclo: 50, maxTentativas: 8, esperaBaseMs: 30_000, esperaMaximaMs: 3_600_000 };
}

interface Registro {
  nivel: "log" | "warn" | "error";
  dados: Record<string, unknown>;
}

/** Portão controlável: o dublê do serviço só termina o ciclo quando o teste libera. */
function portao() {
  let liberar!: () => void;
  const aberto = new Promise<void>((resolver) => {
    liberar = resolver;
  });
  return { aberto, liberar };
}

describe("ReconciliacaoEstoqueWorker — ativação (sem MongoDB)", () => {
  const abertos: TestingModule[] = [];
  const espioes: { mockRestore: () => void }[] = [];

  afterEach(async () => {
    while (espioes.length) espioes.pop()?.mockRestore();
    while (abertos.length) await abertos.pop()?.close();
  });

  async function montar(config: ReconciliacaoEstoqueConfig, ciclo: () => Promise<ResultadoCicloReconciliacao> = async () => CICLO_VAZIO) {
    let ciclos = 0;
    const servicoFalso = {
      reconciliarAutomaticamente: async (): Promise<ResultadoCicloReconciliacao> => {
        ciclos += 1;
        return ciclo();
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [ReconciliacaoEstoqueWorker, { provide: VendasService, useValue: servicoFalso }, { provide: RECONCILIACAO_ESTOQUE_CONFIG, useValue: config }],
    }).compile();
    abertos.push(moduleRef);
    const worker = moduleRef.get(ReconciliacaoEstoqueWorker);
    return { moduleRef, worker, ciclos: () => ciclos, logs: capturarLogs(worker) };
  }

  /** Captura os eventos JSON emitidos pelo logger DESTE worker (nada vai para a saída do teste). */
  function capturarLogs(worker: ReconciliacaoEstoqueWorker): Registro[] {
    const logger = (worker as unknown as { logger: Logger }).logger;
    const registros: Registro[] = [];
    for (const nivel of ["log", "warn", "error"] as const) {
      espioes.push(
        spyOn(logger, nivel).mockImplementation((mensagem: unknown) => {
          registros.push({ nivel, dados: JSON.parse(String(mensagem)) as Record<string, unknown> });
        }),
      );
    }
    return registros;
  }

  /** Faz o logger DESTE worker lançar em todos os níveis. */
  function quebrarLogger(worker: ReconciliacaoEstoqueWorker): void {
    const logger = (worker as unknown as { logger: Logger }).logger;
    for (const nivel of ["log", "warn", "error"] as const) {
      espioes.push(
        spyOn(logger, nivel).mockImplementation(() => {
          throw new Error("[INJETADO] logger quebrado");
        }),
      );
    }
  }

  const eventos = (logs: Registro[]) => logs.map((registro) => registro.dados["evento"]);
  const doEvento = (logs: Registro[], evento: string) => logs.filter((registro) => registro.dados["evento"] === evento);

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

  describe("observabilidade (Fase 60.4.3.4.19.5)", () => {
    it("1. ciclo VAZIO: `ciclo_iniciado` e `ciclo_concluido` (nível log) com o MESMO cicloId e resultado `sem_itens_elegiveis`", async () => {
      const { worker, logs } = await montar(configuracao(true, 60_000));
      expect(await worker.executarCiclo()).toEqual(CICLO_VAZIO);

      expect(eventos(logs)).toEqual(["reconciliacao_estoque.ciclo_iniciado", "reconciliacao_estoque.ciclo_concluido"]);
      const [iniciado, concluido] = logs;
      expect(iniciado!.nivel).toBe("log");
      expect(iniciado!.dados).toMatchObject({ execucaoId: worker.execucaoId, cicloId: `${worker.execucaoId}:1`, intervaloMs: 60_000, loteVendas: 20, maxItensPorCiclo: 50 });
      expect(concluido!.nivel).toBe("log");
      expect(concluido!.dados).toMatchObject({
        execucaoId: worker.execucaoId,
        cicloId: iniciado!.dados["cicloId"],
        iniciadoEm: iniciado!.dados["iniciadoEm"],
        resultado: "sem_itens_elegiveis",
        vendasConsultadas: 0,
        vendasProcessadas: 0,
        itensElegiveis: 0,
        itensConcluidos: 0,
        jaConcluidos: 0,
        falhasRecuperaveis: 0,
        requeremIntervencao: 0,
        adiados: 0,
        indeterminados: 0,
        adiadosNaTransacao: 0,
        indeterminadosNaTransacao: 0,
        falhasNaoRegistradas: 0,
        vendasComErro: 0,
        ticksSobrepostos: 0,
      });
      const iniciadoEm = Date.parse(String(concluido!.dados["iniciadoEm"]));
      const concluidoEm = Date.parse(String(concluido!.dados["concluidoEm"]));
      expect(concluidoEm).toBeGreaterThanOrEqual(iniciadoEm);
      expect(concluido!.dados["duracaoMs"]).toBe(concluidoEm - iniciadoEm);
    });

    it("ciclo com falhas → `ciclo_concluido` em nível WARN e resultado `processado_com_falhas`; sem falhas → `processado`", async () => {
      const resultados: ResultadoCicloReconciliacao[] = [
        { ...CICLO_VAZIO, vendasConsultadas: 1, vendas: 1, tentadas: 1, falhas: 1, falhasRecuperaveis: 1 },
        { ...CICLO_VAZIO, vendasConsultadas: 1, vendas: 1, tentadas: 1, concluidas: 1 },
      ];
      const { worker, logs } = await montar(configuracao(true, 60_000), async () => resultados.shift()!);
      await worker.executarCiclo();
      await worker.executarCiclo();
      const concluidos = doEvento(logs, "reconciliacao_estoque.ciclo_concluido");
      expect(concluidos.map((registro) => [registro.nivel, registro.dados["resultado"]])).toEqual([
        ["warn", "processado_com_falhas"],
        ["log", "processado"],
      ]);
      expect(concluidos[0]!.dados).toMatchObject({ itensElegiveis: 1, falhasRecuperaveis: 1, requeremIntervencao: 0 });
      expect(concluidos[1]!.dados).toMatchObject({ itensElegiveis: 1, itensConcluidos: 1 });
    });

    it("o evento antigo `reconciliacao_estoque.ciclo` não é mais emitido (substituído por `ciclo_concluido`)", async () => {
      const { worker, logs } = await montar(configuracao(true, 60_000), async () => ({ ...CICLO_VAZIO, tentadas: 1, concluidas: 1 }));
      await worker.executarCiclo();
      expect(eventos(logs)).not.toContain("reconciliacao_estoque.ciclo");
    });

    it("2. erro GERAL: `ciclo_iniciado` + `ciclo_falhou` (warn) com categoria e SEM mensagem/URI/host; nenhum `ciclo_concluido`", async () => {
      const { worker, logs } = await montar(configuracao(true, 60_000), async () => {
        throw new MongoServerSelectionError("connect ECONNREFUSED cluster0-shard-00-00.exemplo.mongodb.net:27017 mongodb+srv://usuario:senha@host/db");
      });
      worker.iniciar(); // timer ativo → haverá nova oportunidade
      expect(await worker.executarCiclo()).toBeNull();
      worker.parar();

      expect(eventos(logs)).toEqual(["reconciliacao_estoque.worker_iniciado", "reconciliacao_estoque.ciclo_iniciado", "reconciliacao_estoque.ciclo_falhou"]);
      const iniciado = doEvento(logs, "reconciliacao_estoque.ciclo_iniciado")[0]!;
      const falhou = doEvento(logs, "reconciliacao_estoque.ciclo_falhou")[0]!;
      expect(falhou.nivel).toBe("warn");
      expect(falhou.dados).toMatchObject({
        execucaoId: worker.execucaoId,
        cicloId: iniciado.dados["cicloId"],
        iniciadoEm: iniciado.dados["iniciadoEm"],
        categoriaErro: "banco_indisponivel",
        erroClasse: "MongoServerSelectionError",
        erroCodigo: null,
        novaOportunidade: true,
      });
      expect(typeof falhou.dados["falhouEm"]).toBe("string");
      expect(typeof falhou.dados["duracaoMs"]).toBe("number");
      expect(Object.keys(falhou.dados)).not.toContain("erroMensagem");
      const tudo = JSON.stringify(logs);
      for (const proibido of ["mongodb.net", "mongodb+srv", "usuario", "senha", "ECONNREFUSED", "27017"]) expect(tudo).not.toContain(proibido);
    });

    it("2b. `novaOportunidade: false` quando não há timer agendado (worker parado)", async () => {
      const { worker, logs } = await montar(configuracao(false, 60_000), async () => {
        throw new Error("falha qualquer");
      });
      await worker.executarCiclo();
      expect(doEvento(logs, "reconciliacao_estoque.ciclo_falhou")[0]!.dados).toMatchObject({ categoriaErro: "desconhecido", novaOportunidade: false });
    });

    it("3. falha do LOGGER: o resultado do ciclo é preservado, nada lança, o timer continua e o erro geral continua devolvendo null", async () => {
      const resultado: ResultadoCicloReconciliacao = { ...CICLO_VAZIO, vendasConsultadas: 1, vendas: 1, tentadas: 1, concluidas: 1 };
      let falhar = false;
      const { moduleRef, worker } = await montar(configuracao(true, 60_000), async () => {
        if (falhar) throw new Error("falha geral");
        return resultado;
      });
      quebrarLogger(worker);

      await moduleRef.init(); // bootstrap emite `worker_iniciado` com o logger quebrado
      expect(worker.ativo).toBe(true);
      expect(await worker.executarCiclo()).toEqual(resultado); // nunca vira `ciclo_falhou`/null
      falhar = true;
      expect(await worker.executarCiclo()).toBeNull();
      expect(worker.ativo).toBe(true);
      await moduleRef.close(); // `worker_parando`/`worker_parado` com o logger quebrado
      abertos.pop();
      expect(worker.ativo).toBe(false);
    });

    it("4. SOBREPOSIÇÃO: ticks durante um ciclo reaproveitam a mesma execução, não emitem `ciclo_iniciado` e somam em `ticksSobrepostos`", async () => {
      const { aberto, liberar } = portao();
      let primeiro = true;
      const { worker, logs, ciclos } = await montar(configuracao(true, 60_000), async () => {
        if (primeiro) {
          primeiro = false;
          await aberto;
        }
        return CICLO_VAZIO;
      });
      const a = worker.executarCiclo();
      const b = worker.executarCiclo();
      const c = worker.executarCiclo();
      expect(b).toBe(a);
      expect(c).toBe(a);
      liberar();
      await a;
      expect(ciclos()).toBe(1);
      expect(doEvento(logs, "reconciliacao_estoque.ciclo_iniciado")).toHaveLength(1);
      expect(doEvento(logs, "reconciliacao_estoque.ciclo_concluido")[0]!.dados).toMatchObject({ cicloId: `${worker.execucaoId}:1`, ticksSobrepostos: 2 });

      await worker.executarCiclo(); // o contador é por ciclo
      expect(doEvento(logs, "reconciliacao_estoque.ciclo_concluido")[1]!.dados).toMatchObject({ cicloId: `${worker.execucaoId}:2`, ticksSobrepostos: 0 });
    });

    it("5. DESABILITADO: só `worker_desabilitado` (com execucaoId); nenhum evento de ciclo nem de encerramento", async () => {
      const { moduleRef, worker, logs } = await montar(configuracao(false, 20));
      await moduleRef.init();
      await new Promise((resolver) => setTimeout(resolver, 100));
      await moduleRef.close();
      abertos.pop();
      expect(logs).toEqual([{ nivel: "log", dados: { evento: "reconciliacao_estoque.worker_desabilitado", execucaoId: worker.execucaoId } }]);
    });

    it("6. SHUTDOWN durante ciclo: `worker_parando` (cicloEmAndamento) ANTES de esperar; `worker_parado` só DEPOIS do ciclo terminar", async () => {
      const { aberto, liberar } = portao();
      const { moduleRef, worker, logs } = await montar(configuracao(true, 60_000), async () => {
        await aberto;
        return CICLO_VAZIO;
      });
      await moduleRef.init();
      const ciclo = worker.executarCiclo();
      const fechamento = moduleRef.close();
      abertos.pop();

      // Dá tempo ao Nest de entrar em `onModuleDestroy` (que fica esperando o ciclo).
      const limite = Date.now() + 2_000;
      while (!eventos(logs).includes("reconciliacao_estoque.worker_parando") && Date.now() < limite) await new Promise((resolver) => setTimeout(resolver, 5));
      expect(doEvento(logs, "reconciliacao_estoque.worker_parando")[0]!.dados).toEqual({
        evento: "reconciliacao_estoque.worker_parando",
        execucaoId: worker.execucaoId,
        cicloEmAndamento: true,
      });
      expect(worker.ativo).toBe(false); // timer já parado
      expect(eventos(logs)).not.toContain("reconciliacao_estoque.worker_parado");
      expect(eventos(logs)).not.toContain("reconciliacao_estoque.ciclo_concluido");

      liberar();
      await ciclo;
      await fechamento;
      expect(eventos(logs)).toEqual([
        "reconciliacao_estoque.worker_iniciado",
        "reconciliacao_estoque.ciclo_iniciado",
        "reconciliacao_estoque.worker_parando",
        "reconciliacao_estoque.ciclo_concluido",
        "reconciliacao_estoque.worker_parado",
      ]);
      expect(doEvento(logs, "reconciliacao_estoque.worker_parado")[0]!.dados).toEqual({
        evento: "reconciliacao_estoque.worker_parado",
        execucaoId: worker.execucaoId,
        ciclosExecutados: 1,
      });
    });

    it("6b. shutdown SEM ciclo em andamento: `cicloEmAndamento: false`", async () => {
      const { moduleRef, logs } = await montar(configuracao(true, 60_000));
      await moduleRef.init();
      await moduleRef.close();
      abertos.pop();
      expect(doEvento(logs, "reconciliacao_estoque.worker_parando")[0]!.dados).toMatchObject({ cicloEmAndamento: false });
      expect(doEvento(logs, "reconciliacao_estoque.worker_parado")[0]!.dados).toMatchObject({ ciclosExecutados: 0 });
    });

    it("7. IDENTIDADE: execucaoId é UUID fixo por worker, distinto entre instâncias; cicloId sequencial a partir de 1", async () => {
      const a = await montar(configuracao(true, 60_000));
      const b = await montar(configuracao(true, 60_000));
      expect(a.worker.execucaoId).toMatch(UUID);
      expect(b.worker.execucaoId).toMatch(UUID);
      expect(a.worker.execucaoId).not.toBe(b.worker.execucaoId);

      await a.worker.executarCiclo();
      await a.worker.executarCiclo();
      await a.worker.executarCiclo();
      const ids = doEvento(a.logs, "reconciliacao_estoque.ciclo_iniciado").map((registro) => registro.dados["cicloId"]);
      expect(ids).toEqual([1, 2, 3].map((n) => `${a.worker.execucaoId}:${n}`));
      const concluidos = doEvento(a.logs, "reconciliacao_estoque.ciclo_concluido").map((registro) => registro.dados["cicloId"]);
      expect(concluidos).toEqual(ids);
      expect(new Set(doEvento(a.logs, "reconciliacao_estoque.ciclo_iniciado").map((registro) => registro.dados["execucaoId"]))).toEqual(new Set([a.worker.execucaoId]));
    });

    it("`worker_iniciado` traz execucaoId, metadados da plataforma (null fora do Render) e a configuração", async () => {
      const anteriores = { commit: process.env["RENDER_GIT_COMMIT"], instancia: process.env["RENDER_INSTANCE_ID"] };
      delete process.env["RENDER_GIT_COMMIT"];
      delete process.env["RENDER_INSTANCE_ID"];
      try {
        const { moduleRef, worker, logs } = await montar(configuracao(true, 60_000));
        await moduleRef.init();
        expect(logs[0]!.dados).toEqual({
          evento: "reconciliacao_estoque.worker_iniciado",
          execucaoId: worker.execucaoId,
          commit: null,
          instancia: null,
          intervaloMs: 60_000,
          loteVendas: 20,
          maxItensPorCiclo: 50,
          maxTentativas: 8,
        });
      } finally {
        if (anteriores.commit !== undefined) process.env["RENDER_GIT_COMMIT"] = anteriores.commit;
        if (anteriores.instancia !== undefined) process.env["RENDER_INSTANCE_ID"] = anteriores.instancia;
      }
    });
  });
});
