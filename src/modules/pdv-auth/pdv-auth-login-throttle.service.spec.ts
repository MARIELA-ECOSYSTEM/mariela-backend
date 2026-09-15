import { describe, expect, it } from "bun:test";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { PDV_LOGIN_THROTTLE_JANELA_MS, PDV_LOGIN_THROTTLE_MAX_TENTATIVAS } from "./pdv-auth.constants.js";
import { PdvAuthLoginThrottleService } from "./pdv-auth-login-throttle.service.js";

/**
 * Etapa 10.23 — correção 6.8 (espelho PDV): mesma correção e mesma
 * justificativa de `modules/auth/login-throttle.service.spec.ts` (ADMIN),
 * duplicada aqui de propósito (mesmo padrão de isolamento arquitetural já
 * usado no restante de `pdv-auth`).
 */
function acessarMapaInterno(servico: PdvAuthLoginThrottleService) {
  return (servico as unknown as { tentativas: Map<string, { falhas: number; primeiraFalhaEm: number }> }).tentativas;
}

describe("PdvAuthLoginThrottleService (Etapa 10.23 — limpeza de entradas expiradas)", () => {
  it("bloqueio continua funcionando: 5 falhas dentro da janela lançam TOO_MANY_REQUESTS", () => {
    const servico = new PdvAuthLoginThrottleService();
    const chave = "1.2.3.4:VEN-0001";

    for (let i = 0; i < PDV_LOGIN_THROTTLE_MAX_TENTATIVAS; i += 1) {
      servico.verificar(chave);
      servico.registrarFalha(chave);
    }

    expect(() => servico.verificar(chave)).toThrow(ApiException);
  });

  it("sucesso continua limpando o registro (nenhuma regressão no fluxo de login)", () => {
    const servico = new PdvAuthLoginThrottleService();
    const chave = "1.2.3.4:VEN-0002";

    servico.registrarFalha(chave);
    servico.registrarSucesso(chave);

    expect(() => servico.verificar(chave)).not.toThrow();
    expect(acessarMapaInterno(servico).has(chave)).toBe(false);
  });

  it("entradas EXPIRADAS podem ser removidas por verificar()", () => {
    const servico = new PdvAuthLoginThrottleService();
    const chave = "1.2.3.4:VEN-0003";
    const mapa = acessarMapaInterno(servico);
    mapa.set(chave, { falhas: PDV_LOGIN_THROTTLE_MAX_TENTATIVAS, primeiraFalhaEm: Date.now() - PDV_LOGIN_THROTTLE_JANELA_MS - 1000 });

    servico.verificar(chave);

    expect(mapa.has(chave)).toBe(false);
  });

  it("nenhuma entrada ATIVA é removida prematuramente", () => {
    const servico = new PdvAuthLoginThrottleService();
    const chaveAtiva = "1.2.3.4:VEN-0004";
    const chaveExpirada = "1.2.3.4:VEN-0005";
    const mapa = acessarMapaInterno(servico);
    mapa.set(chaveAtiva, { falhas: 2, primeiraFalhaEm: Date.now() - 1000 });
    mapa.set(chaveExpirada, { falhas: 5, primeiraFalhaEm: Date.now() - PDV_LOGIN_THROTTLE_JANELA_MS - 1000 });

    servico.verificar(chaveAtiva);

    expect(mapa.has(chaveAtiva)).toBe(true);
    expect(mapa.get(chaveAtiva)?.falhas).toBe(2);
    expect(mapa.has(chaveExpirada)).toBe(false);
  });

  it("a varredura nunca deixa o Map crescer indefinidamente com chaves só expiradas", () => {
    const servico = new PdvAuthLoginThrottleService();
    const mapa = acessarMapaInterno(servico);
    for (let i = 0; i < 50; i += 1) {
      mapa.set(`ip-${i}:VEN-${i}`, { falhas: 1, primeiraFalhaEm: Date.now() - PDV_LOGIN_THROTTLE_JANELA_MS - 1000 });
    }
    expect(servico.tamanhoParaTeste()).toBe(50);

    servico.verificar("VEN-nova");

    expect(servico.tamanhoParaTeste()).toBe(0);
  });
});
