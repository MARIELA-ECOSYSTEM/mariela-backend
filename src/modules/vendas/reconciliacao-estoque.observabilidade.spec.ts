import { describe, expect, it } from "bun:test";
import { mongo } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import {
  categorizarErroDeCiclo,
  classificarResultadoDoCiclo,
  contadoresDoCiclo,
  emitirSeguro,
  identificarErro,
  metadadosDaPlataforma,
  type ContadoresDoCiclo,
} from "./reconciliacao-estoque.observabilidade.js";
import type { ResultadoCicloReconciliacao } from "./vendas.service.js";

/** Fase 60.4.3.4.19.5 — funções PURAS da observabilidade do worker (sem MongoDB). */

const RESULTADO_VAZIO: ResultadoCicloReconciliacao = {
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

function contadores(parcial: Partial<ContadoresDoCiclo>): ContadoresDoCiclo {
  return { ...contadoresDoCiclo(RESULTADO_VAZIO, 0), ...parcial };
}

class MongoServerSelectionError extends Error {}
class MongoNetworkError extends Error {}

describe("contadoresDoCiclo", () => {
  it("mapeia os campos do service e SEPARA adiadas/indeterminadas da pré-checagem e da transação (sem sobreposição)", () => {
    const c = contadoresDoCiclo(
      {
        ...RESULTADO_VAZIO,
        vendasConsultadas: 3,
        vendas: 2,
        tentadas: 6,
        concluidas: 1,
        jaConcluidas: 1,
        falhas: 3,
        falhasRecuperaveis: 1,
        requeremIntervencao: 1,
        falhasNaoRegistradas: 1,
        adiadas: 4,
        adiadasNaTransacao: 1,
        indeterminadas: 2,
        indeterminadasNaTransacao: 0,
        vendasComErro: 1,
      },
      2,
    );
    expect(c).toEqual({
      vendasConsultadas: 3,
      vendasProcessadas: 2,
      itensElegiveis: 6,
      itensConcluidos: 1,
      jaConcluidos: 1,
      falhasRecuperaveis: 1,
      requeremIntervencao: 1,
      adiados: 3,
      indeterminados: 2,
      adiadosNaTransacao: 1,
      indeterminadosNaTransacao: 0,
      falhasNaoRegistradas: 1,
      vendasComErro: 1,
      ticksSobrepostos: 2,
    });
    // Identidade documentada: cada linha tentada tem exatamente um desfecho.
    expect(c.itensElegiveis).toBe(
      c.itensConcluidos + c.jaConcluidos + c.falhasRecuperaveis + c.requeremIntervencao + c.falhasNaoRegistradas + c.adiadosNaTransacao + c.indeterminadosNaTransacao,
    );
  });
});

describe("classificarResultadoDoCiclo", () => {
  it("ciclo vazio → sem_itens_elegiveis", () => {
    expect(classificarResultadoDoCiclo(contadores({}))).toBe("sem_itens_elegiveis");
  });

  it("só linhas adiadas/indeterminadas (nenhuma tentada) → sem_itens_elegiveis", () => {
    expect(classificarResultadoDoCiclo(contadores({ vendasConsultadas: 1, vendasProcessadas: 1, adiados: 2, indeterminados: 1 }))).toBe("sem_itens_elegiveis");
  });

  it("itens tentados sem falha → processado (inclusive quando a releitura encontrou a linha já concluída)", () => {
    expect(classificarResultadoDoCiclo(contadores({ itensElegiveis: 1, itensConcluidos: 1 }))).toBe("processado");
    expect(classificarResultadoDoCiclo(contadores({ itensElegiveis: 1, jaConcluidos: 1 }))).toBe("processado");
  });

  it.each([
    ["falhasRecuperaveis", { itensElegiveis: 1, falhasRecuperaveis: 1 }],
    ["requeremIntervencao", { itensElegiveis: 1, requeremIntervencao: 1 }],
    ["falhasNaoRegistradas", { itensElegiveis: 1, falhasNaoRegistradas: 1 }],
    ["vendasComErro (mesmo sem itens tentados)", { vendasComErro: 1 }],
  ] as const)("%s → processado_com_falhas", (_nome, parcial) => {
    expect(classificarResultadoDoCiclo(contadores(parcial))).toBe("processado_com_falhas");
  });
});

describe("categorizarErroDeCiclo / identificarErro", () => {
  it("indisponibilidade do banco (seleção de servidor, rede) → banco_indisponivel", () => {
    expect(categorizarErroDeCiclo(new MongoServerSelectionError("x"))).toBe("banco_indisponivel");
    expect(categorizarErroDeCiclo(new MongoNetworkError("x"))).toBe("banco_indisponivel");
  });

  it("erro transitório de transação (rótulo ou codeName) e conflito da API → conflito_transacao", () => {
    const transitorio = new mongo.MongoServerError({ message: "x", code: 112, codeName: "WriteConflict" });
    transitorio.addErrorLabel("TransientTransactionError");
    expect(categorizarErroDeCiclo(transitorio)).toBe("conflito_transacao");
    expect(categorizarErroDeCiclo(new mongo.MongoServerError({ message: "x", code: 251, codeName: "NoSuchTransaction" }))).toBe("conflito_transacao");
    expect(categorizarErroDeCiclo(ApiException.conflict())).toBe("conflito_transacao");
  });

  it("outros erros do driver → erro_banco; qualquer outro → desconhecido", () => {
    expect(categorizarErroDeCiclo(new mongo.MongoServerError({ message: "x", code: 11000, codeName: "DuplicateKey" }))).toBe("erro_banco");
    expect(categorizarErroDeCiclo(new Error("x"))).toBe("desconhecido");
    expect(categorizarErroDeCiclo("texto")).toBe("desconhecido");
    expect(categorizarErroDeCiclo(null)).toBe("desconhecido");
  });

  it("identificarErro devolve só classe e código — nunca a mensagem (que pode conter host/URI)", () => {
    const erro = new MongoServerSelectionError("connect ECONNREFUSED cluster0-shard-00-00.exemplo.mongodb.net:27017 mongodb+srv://usuario:senha@host/db");
    const id = identificarErro(erro);
    expect(id).toEqual({ erroClasse: "MongoServerSelectionError", erroCodigo: null });
    expect(JSON.stringify(id)).not.toContain("mongodb");
  });
});

describe("metadadosDaPlataforma", () => {
  it("lê SÓ RENDER_GIT_COMMIT e RENDER_INSTANCE_ID, validados por formato", () => {
    expect(metadadosDaPlataforma({ RENDER_GIT_COMMIT: "44FC359D0A62D7C03B7E64E388787F2B248B8032", RENDER_INSTANCE_ID: "srv-abc123-xyz9", MONGODB_URI: "segredo" })).toEqual({
      commit: "44fc359d0a62d7c03b7e64e388787f2b248b8032",
      instancia: "srv-abc123-xyz9",
    });
  });

  it("ausentes ou fora do formato → null (nunca ecoa valor arbitrário)", () => {
    expect(metadadosDaPlataforma({})).toEqual({ commit: null, instancia: null });
    expect(metadadosDaPlataforma({ RENDER_GIT_COMMIT: "não é sha", RENDER_INSTANCE_ID: "mongodb+srv://u:p@h/db" })).toEqual({ commit: null, instancia: null });
  });
});

describe("emitirSeguro", () => {
  function loggerQueGrava() {
    const linhas: { nivel: string; mensagem: string }[] = [];
    return {
      linhas,
      logger: {
        log: (mensagem: string) => linhas.push({ nivel: "log", mensagem }),
        warn: (mensagem: string) => linhas.push({ nivel: "warn", mensagem }),
        error: (mensagem: string) => linhas.push({ nivel: "error", mensagem }),
      },
    };
  }

  it("encaminha ao nível pedido, com JSON na mensagem", () => {
    const { linhas, logger } = loggerQueGrava();
    emitirSeguro(logger, "log", { evento: "a" });
    emitirSeguro(logger, "warn", { evento: "b" });
    emitirSeguro(logger, "error", { evento: "c" });
    expect(linhas).toEqual([
      { nivel: "log", mensagem: '{"evento":"a"}' },
      { nivel: "warn", mensagem: '{"evento":"b"}' },
      { nivel: "error", mensagem: '{"evento":"c"}' },
    ]);
  });

  it("nunca lança: logger que falha e dado não serializável são descartados", () => {
    const quebrado = {
      log: () => {
        throw new Error("logger quebrado");
      },
      warn: () => {
        throw new Error("logger quebrado");
      },
      error: () => {
        throw new Error("logger quebrado");
      },
    };
    expect(() => emitirSeguro(quebrado, "log", { evento: "x" })).not.toThrow();
    expect(() => emitirSeguro(quebrado, "error", { evento: "x" })).not.toThrow();
    const circular: Record<string, unknown> = {};
    circular["eu"] = circular;
    const { linhas, logger } = loggerQueGrava();
    expect(() => emitirSeguro(logger, "log", circular)).not.toThrow();
    expect(linhas).toHaveLength(0);
  });
});
