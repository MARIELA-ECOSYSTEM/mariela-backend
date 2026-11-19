import { describe, expect, it } from "bun:test";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { LimiteUploadMidiaGuard, LimiteUploadMidiaService, LimitarUploadMidia } from "./limite-upload-midia.js";
import { LIMITE_REQUISICOES_UPLOAD } from "./media.constants.js";

/** Fase 22.8.9.9 — limite de requisições das operações de upload (unitário; relógio controlado, sem banco). */

function servicoComRelogio(inicio = 1_000_000) {
  const servico = new LimiteUploadMidiaService();
  let agora = inicio;
  servico.agora = () => agora;
  return { servico, avancar: (ms: number) => (agora += ms) };
}

const { limite: LIMITE, janelaMs: JANELA } = LIMITE_REQUISICOES_UPLOAD.solicitacao;

describe("LimiteUploadMidiaService", () => {
  it("15. permite exatamente o limite dentro da janela", () => {
    const { servico } = servicoComRelogio();
    for (let i = 0; i < LIMITE; i += 1) expect(servico.registrar("solicitacao", "admin-a")).toEqual({ permitido: true });
  });

  it("16. recusa o excesso e informa quando tentar de novo; recusas não consomem cota", () => {
    const { servico, avancar } = servicoComRelogio();
    for (let i = 0; i < LIMITE; i += 1) servico.registrar("solicitacao", "admin-a");
    avancar(20_000);
    const recusa = servico.registrar("solicitacao", "admin-a");
    expect(recusa).toEqual({ permitido: false, retryAfterSegundos: Math.ceil((JANELA - 20_000) / 1000) });
    for (let i = 0; i < 5; i += 1) expect(servico.registrar("solicitacao", "admin-a").permitido).toBe(false);
  });

  it("17. a cota é por ADMIN: outro administrador não é afetado", () => {
    const { servico } = servicoComRelogio();
    for (let i = 0; i < LIMITE; i += 1) servico.registrar("solicitacao", "admin-a");
    expect(servico.registrar("solicitacao", "admin-a").permitido).toBe(false);
    expect(servico.registrar("solicitacao", "admin-b").permitido).toBe(true);
  });

  it("solicitação e confirmação têm cotas separadas", () => {
    const { servico } = servicoComRelogio();
    for (let i = 0; i < LIMITE; i += 1) servico.registrar("solicitacao", "admin-a");
    expect(servico.registrar("solicitacao", "admin-a").permitido).toBe(false);
    expect(servico.registrar("confirmacao", "admin-a").permitido).toBe(true);
  });

  it("19. uma nova janela permite novas tentativas", () => {
    const { servico, avancar } = servicoComRelogio();
    for (let i = 0; i < LIMITE; i += 1) servico.registrar("solicitacao", "admin-a");
    avancar(JANELA - 1);
    expect(servico.registrar("solicitacao", "admin-a").permitido).toBe(false);
    avancar(1);
    for (let i = 0; i < LIMITE; i += 1) expect(servico.registrar("solicitacao", "admin-a").permitido).toBe(true);
    expect(servico.registrar("solicitacao", "admin-a").permitido).toBe(false);
  });

  it("a memória é limitada: janelas vencidas são descartadas quando há muitas chaves", () => {
    const { servico, avancar } = servicoComRelogio();
    for (let i = 0; i < 1_500; i += 1) servico.registrar("solicitacao", `admin-${i}`);
    avancar(JANELA);
    servico.registrar("solicitacao", "admin-novo");
    const janelas = (servico as unknown as { janelas: Map<string, unknown> }).janelas;
    expect(janelas.size).toBe(1);
  });
});

describe("LimiteUploadMidiaGuard", () => {
  class ControllerFalso {
    @LimitarUploadMidia("solicitacao")
    solicitar() {}
    semLimite() {}
  }

  function contexto(handler: () => void, user: unknown, cabecalhos: Record<string, string>): ExecutionContext {
    return {
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({ user }),
        getResponse: () => ({ setHeader: (nome: string, valor: string) => (cabecalhos[nome] = valor) }),
      }),
    } as unknown as ExecutionContext;
  }

  it("16/17. usa o `sub` do ADMIN autenticado; no excesso lança 429 TOO_MANY_REQUESTS com Retry-After e sem detalhes internos", () => {
    const { servico } = servicoComRelogio();
    const guard = new LimiteUploadMidiaGuard(new Reflector(), servico);
    const handler = ControllerFalso.prototype.solicitar;
    const cabecalhos: Record<string, string> = {};
    for (let i = 0; i < LIMITE; i += 1) expect(guard.canActivate(contexto(handler, { sub: "admin-a" }, cabecalhos))).toBe(true);
    let erro: unknown;
    try {
      guard.canActivate(contexto(handler, { sub: "admin-a" }, cabecalhos));
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ApiException);
    expect((erro as ApiException).getStatus()).toBe(429);
    expect((erro as ApiException).code).toBe("TOO_MANY_REQUESTS");
    expect((erro as ApiException).message).not.toMatch(/admin-a|solicitacao|janela|contagem/i);
    expect(cabecalhos["Retry-After"]).toBe(String(JANELA / 1000));
    // Outro ADMIN no mesmo processo segue liberado.
    expect(guard.canActivate(contexto(handler, { sub: "admin-b" }, {}))).toBe(true);
  });

  it("20. handler sem a marcação não é limitado", () => {
    const { servico } = servicoComRelogio();
    const guard = new LimiteUploadMidiaGuard(new Reflector(), servico);
    for (let i = 0; i < LIMITE * 3; i += 1) expect(guard.canActivate(contexto(ControllerFalso.prototype.semLimite, { sub: "admin-a" }, {}))).toBe(true);
  });

  it("sem identidade autenticada: 401 (nunca uma cota anônima compartilhada)", () => {
    const { servico } = servicoComRelogio();
    const guard = new LimiteUploadMidiaGuard(new Reflector(), servico);
    for (const user of [undefined, {}, { sub: "" }, { sub: 123 }]) {
      expect(() => guard.canActivate(contexto(ControllerFalso.prototype.solicitar, user, {}))).toThrow(ApiException);
    }
  });
});
