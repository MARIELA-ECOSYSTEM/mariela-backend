import { describe, expect, it } from "bun:test";
import { mongo } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import {
  calcularEsperaDeRestauracao,
  descreverFalhaDeRestauracao,
  estadoEfetivoDaRestauracao,
  linhaElegivelParaReconciliacaoAutomatica,
  resumoRestauracao,
} from "./restauracao-estoque.util.js";

/** Fase 60.4.3.4.18 — regras puras da reconciliação de estoque (sem MongoDB). */
describe("restauracao-estoque.util", () => {
  describe("estadoEfetivoDaRestauracao — compatibilidade com eventos legados", () => {
    it("legado `restaurado: true` (sem estado explícito) é concluída", () => {
      expect(estadoEfetivoDaRestauracao({ restaurado: true })).toBe("concluida");
    });

    it("legado `restaurado: false` (sem estado explícito) é pendente", () => {
      expect(estadoEfetivoDaRestauracao({ restaurado: false })).toBe("pendente");
    });

    it("campo `restaurado` AUSENTE nunca é lido como concluída", () => {
      expect(estadoEfetivoDaRestauracao({})).toBe("pendente");
      expect(estadoEfetivoDaRestauracao({ restaurado: null })).toBe("pendente");
    });

    it("`estadoRestauracao: concluida` sem `restaurado: true` (inconsistente) continua pendente — o booleano é a fonte de verdade", () => {
      expect(estadoEfetivoDaRestauracao({ restaurado: false, estadoRestauracao: "concluida" })).toBe("pendente");
    });

    it("estados de falha persistidos são preservados enquanto a linha não for restaurada", () => {
      expect(estadoEfetivoDaRestauracao({ restaurado: false, estadoRestauracao: "falha_recuperavel" })).toBe("falha_recuperavel");
      expect(estadoEfetivoDaRestauracao({ restaurado: false, estadoRestauracao: "requer_intervencao" })).toBe("requer_intervencao");
      expect(estadoEfetivoDaRestauracao({ restaurado: true, estadoRestauracao: "requer_intervencao" })).toBe("concluida");
    });
  });

  describe("linhaElegivelParaReconciliacaoAutomatica", () => {
    const agora = new Date("2026-11-07T12:00:00.000Z");

    it("pendente sem agenda é elegível; com agenda futura não; com agenda vencida sim", () => {
      expect(linhaElegivelParaReconciliacaoAutomatica({ restaurado: false }, agora)).toBe(true);
      expect(linhaElegivelParaReconciliacaoAutomatica({ restaurado: false, proximaTentativaEm: new Date(agora.getTime() + 1) }, agora)).toBe(false);
      expect(linhaElegivelParaReconciliacaoAutomatica({ restaurado: false, proximaTentativaEm: agora }, agora)).toBe(true);
    });

    it("concluída e `requer_intervencao` nunca são elegíveis para o worker", () => {
      expect(linhaElegivelParaReconciliacaoAutomatica({ restaurado: true }, agora)).toBe(false);
      expect(linhaElegivelParaReconciliacaoAutomatica({ restaurado: false, estadoRestauracao: "requer_intervencao", proximaTentativaEm: null }, agora)).toBe(false);
    });

    it("linha legada sem nenhum campo é elegível (ausência = pendente)", () => {
      expect(linhaElegivelParaReconciliacaoAutomatica({}, agora)).toBe(true);
    });
  });

  describe("resumoRestauracao", () => {
    it("sem eventos: nao_aplicavel", () => {
      expect(resumoRestauracao([]).status).toBe("nao_aplicavel");
      expect(resumoRestauracao(undefined).status).toBe("nao_aplicavel");
    });

    it("tudo restaurado: concluida", () => {
      const resumo = resumoRestauracao([{ itens: [{ restaurado: true }, { restaurado: true }] }]);
      expect(resumo).toMatchObject({ status: "concluida", totalItens: 2, concluidos: 2, pendentes: 0 });
    });

    it("evento parcialmente restaurado: pendente, com contagens e a MENOR agenda", () => {
      const cedo = new Date("2026-11-07T12:00:00.000Z");
      const tarde = new Date("2026-11-07T13:00:00.000Z");
      const resumo = resumoRestauracao([
        { itens: [{ restaurado: true }, { restaurado: false, estadoRestauracao: "falha_recuperavel", proximaTentativaEm: tarde }] },
        { itens: [{ restaurado: false, proximaTentativaEm: cedo }, {}] },
      ]);
      expect(resumo).toEqual({
        status: "pendente",
        totalItens: 4,
        concluidos: 1,
        pendentes: 2,
        emFalhaRecuperavel: 1,
        requerIntervencao: 0,
        proximaTentativaEm: cedo,
      });
    });

    it("qualquer linha `requer_intervencao` torna o status da venda `requer_intervencao`", () => {
      const resumo = resumoRestauracao([{ itens: [{ restaurado: false }, { restaurado: false, estadoRestauracao: "requer_intervencao" }] }]);
      expect(resumo.status).toBe("requer_intervencao");
      expect(resumo.requerIntervencao).toBe(1);
    });
  });

  describe("calcularEsperaDeRestauracao — backoff exponencial limitado", () => {
    it("base × 2^(n−1), limitado ao máximo", () => {
      expect(calcularEsperaDeRestauracao(1, 30_000, 3_600_000)).toBe(30_000);
      expect(calcularEsperaDeRestauracao(2, 30_000, 3_600_000)).toBe(60_000);
      expect(calcularEsperaDeRestauracao(4, 30_000, 3_600_000)).toBe(240_000);
      expect(calcularEsperaDeRestauracao(8, 30_000, 3_600_000)).toBe(3_600_000);
    });

    it("nunca produz Infinity/NaN com contagens absurdas e trata 0 como primeira espera", () => {
      expect(calcularEsperaDeRestauracao(10_000, 30_000, 3_600_000)).toBe(3_600_000);
      expect(calcularEsperaDeRestauracao(0, 30_000, 3_600_000)).toBe(30_000);
    });
  });

  describe("descreverFalhaDeRestauracao — dados seguros", () => {
    it("nunca inclui stack trace e remove URIs (inclusive com credenciais) da mensagem", () => {
      const erro = new Error("falha ao conectar em mongodb+srv://usuario:segredo@host.exemplo/banco?x=1 depois de 3 tentativas");
      const descricao = descreverFalhaDeRestauracao(erro);
      expect(descricao.classe).toBe("Error");
      expect(descricao.mensagem).not.toContain("segredo");
      expect(descricao.mensagem).not.toContain("mongodb+srv");
      expect(descricao.mensagem).toContain("[uri-removida]");
      expect(JSON.stringify(descricao)).not.toContain("    at ");
    });

    it("trunca mensagens longas", () => {
      const descricao = descreverFalhaDeRestauracao(new Error("x".repeat(1_000)));
      expect(descricao.mensagem.length).toBeLessThanOrEqual(201);
    });

    it("usa `codeName` do servidor MongoDB quando existe (ex.: WriteConflict)", () => {
      const erro = new mongo.MongoServerError({ message: "conflito", code: 112, codeName: "WriteConflict" });
      expect(descreverFalhaDeRestauracao(erro)).toMatchObject({ classe: "MongoServerError", codigo: "WriteConflict" });
    });

    it("ApiException do domínio e valores não-Error", () => {
      expect(descreverFalhaDeRestauracao(ApiException.validation("Estoque insuficiente.")).classe).toBe("ApiException");
      expect(descreverFalhaDeRestauracao("texto")).toEqual({ classe: "string", codigo: null, mensagem: "Falha não identificada." });
    });
  });
});
