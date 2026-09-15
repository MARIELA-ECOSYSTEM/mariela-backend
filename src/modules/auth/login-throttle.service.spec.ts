import { describe, expect, it } from "bun:test";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { LOGIN_THROTTLE_JANELA_MS, LOGIN_THROTTLE_MAX_TENTATIVAS } from "./auth.constants.js";
import { LoginThrottleService } from "./login-throttle.service.js";

/**
 * Etapa 10.23 — correção 6.8: `LoginThrottleService.tentativas` (Map em
 * memória) não tinha nenhum mecanismo de limpeza — uma entrada, uma vez
 * criada, nunca era removida, mesmo muito depois de expirada. Estes testes
 * comprovam a limpeza sem alterar `LOGIN_THROTTLE_MAX_TENTATIVAS`/
 * `LOGIN_THROTTLE_JANELA_MS` (preservados exatamente como estão) e sem
 * esperar os 15 minutos reais da janela: como não há MongoDB envolvido aqui
 * (só `Map`/`Date.now()` em memória), semear diretamente um `primeiraFalhaEm`
 * no passado é a forma honesta de simular "já expirou" — observa o mesmo
 * relógio real (`Date.now()`) que o código de produção usa, não um mock.
 */
function acessarMapaInterno(servico: LoginThrottleService) {
  return (servico as unknown as { tentativas: Map<string, { falhas: number; primeiraFalhaEm: number }> }).tentativas;
}

describe("LoginThrottleService (Etapa 10.23 — limpeza de entradas expiradas)", () => {
  it("bloqueio continua funcionando: 5 falhas dentro da janela lançam TOO_MANY_REQUESTS", () => {
    const servico = new LoginThrottleService();
    const chave = "1.2.3.4:teste@mariela.com";

    for (let i = 0; i < LOGIN_THROTTLE_MAX_TENTATIVAS; i += 1) {
      servico.verificar(chave); // nunca lança antes da 5ª falha
      servico.registrarFalha(chave);
    }

    expect(() => servico.verificar(chave)).toThrow(ApiException);
  });

  it("sucesso continua limpando o registro (nenhuma regressão no fluxo de login)", () => {
    const servico = new LoginThrottleService();
    const chave = "1.2.3.4:sucesso@mariela.com";

    servico.registrarFalha(chave);
    servico.registrarFalha(chave);
    servico.registrarSucesso(chave);

    expect(() => servico.verificar(chave)).not.toThrow();
    expect(acessarMapaInterno(servico).has(chave)).toBe(false);
  });

  it("entradas EXPIRADAS podem ser removidas por verificar()", () => {
    const servico = new LoginThrottleService();
    const chave = "1.2.3.4:expirada@mariela.com";
    const mapa = acessarMapaInterno(servico);
    // Semeia diretamente uma entrada já fora da janela real de 15 minutos
    // (JANELA_MS inalterada) — equivalente a "esperar 15 minutos", sem esperar.
    mapa.set(chave, { falhas: LOGIN_THROTTLE_MAX_TENTATIVAS, primeiraFalhaEm: Date.now() - LOGIN_THROTTLE_JANELA_MS - 1000 });

    servico.verificar(chave); // não lança: a entrada expirada nunca deveria bloquear

    expect(mapa.has(chave)).toBe(false); // e foi de fato removida do Map, não só ignorada
  });

  it("nenhuma entrada ATIVA é removida prematuramente", () => {
    const servico = new LoginThrottleService();
    const chaveAtiva = "1.2.3.4:ativa@mariela.com";
    const chaveExpirada = "1.2.3.4:expirada2@mariela.com";
    const mapa = acessarMapaInterno(servico);
    mapa.set(chaveAtiva, { falhas: 3, primeiraFalhaEm: Date.now() - 1000 }); // bem dentro da janela
    mapa.set(chaveExpirada, { falhas: 5, primeiraFalhaEm: Date.now() - LOGIN_THROTTLE_JANELA_MS - 1000 });

    servico.verificar(chaveAtiva); // dispara a varredura interna

    expect(mapa.has(chaveAtiva)).toBe(true); // ativa preservada
    expect(mapa.get(chaveAtiva)?.falhas).toBe(3); // com o estado intacto, nunca resetado
    expect(mapa.has(chaveExpirada)).toBe(false); // só a expirada foi varrida
  });

  it("a varredura nunca deixa o Map crescer indefinidamente com chaves só expiradas", () => {
    const servico = new LoginThrottleService();
    const mapa = acessarMapaInterno(servico);
    for (let i = 0; i < 50; i += 1) {
      mapa.set(`ip-${i}:usuario${i}@mariela.com`, { falhas: 1, primeiraFalhaEm: Date.now() - LOGIN_THROTTLE_JANELA_MS - 1000 });
    }
    expect(servico.tamanhoParaTeste()).toBe(50);

    servico.verificar("qualquer-chave-nova@mariela.com"); // qualquer chamada varre todo o Map — `verificar()` nunca cria entrada própria

    expect(servico.tamanhoParaTeste()).toBe(0); // as 50 entradas expiradas foram removidas; nenhuma nova foi criada
  });
});
