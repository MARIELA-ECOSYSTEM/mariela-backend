import { describe, expect, it } from "bun:test";
import { hashConteudoEnvio, hashConteudoTexto, validarTextoLivre } from "../envios/envios-whatsapp.service.js";
import { JANELA_ATENDIMENTO_MS, LIMITE_TEXTO_LIVRE_WHATSAPP, MARGEM_SEGURANCA_JANELA_MS } from "../envios/envios-whatsapp.constants.js";
import { avaliarJanela, fimDaJanela, inicioDaJanela, mensagemAindaAbreJanela } from "./janela-atendimento.js";

/** Fase 22.8.9.10.7.4 — regras PURAS da janela de atendimento e do texto livre (sem rede, sem MongoDB). */
const AGORA = new Date("2026-11-24T15:00:00Z");
const menos = (ms: number) => new Date(AGORA.getTime() - ms);
const H = 60 * 60_000;

describe("janela de atendimento de 24 h", () => {
  it("sem registro de mensagem recebida → sem_mensagem (nunca presume aberta)", () => {
    expect(avaliarJanela(null, AGORA)).toEqual({ tipo: "sem_mensagem" });
  });

  it("mensagem recente → aberta, expira 24 h depois MENOS a margem de segurança", () => {
    const ultima = menos(2 * H);
    const r = avaliarJanela(ultima, AGORA);
    expect(r.tipo).toBe("aberta");
    if (r.tipo !== "aberta") return;
    expect(r.expiraEm.getTime()).toBe(ultima.getTime() + JANELA_ATENDIMENTO_MS - MARGEM_SEGURANCA_JANELA_MS);
  });

  it("limites: 1 ms antes do fim (com margem) = aberta; no fim = expirada; 24 h exatas = expirada", () => {
    const naBorda = new Date(AGORA.getTime() - (JANELA_ATENDIMENTO_MS - MARGEM_SEGURANCA_JANELA_MS) + 1);
    expect(avaliarJanela(naBorda, AGORA).tipo).toBe("aberta");
    expect(avaliarJanela(menos(JANELA_ATENDIMENTO_MS - MARGEM_SEGURANCA_JANELA_MS), AGORA).tipo).toBe("expirada");
    expect(avaliarJanela(menos(JANELA_ATENDIMENTO_MS), AGORA).tipo).toBe("expirada");
    expect(avaliarJanela(menos(23 * H + 55 * 60_000), AGORA).tipo).toBe("expirada"); // dentro das 24 h, mas na margem
  });

  it("início = timestamp da Meta, nunca depois do relógio do backend (timestamp no futuro não estende)", () => {
    const passado = menos(H);
    expect(inicioDaJanela(passado, AGORA)).toBe(passado);
    expect(inicioDaJanela(new Date(AGORA.getTime() + 10 * H), AGORA)).toBe(AGORA);
    expect(fimDaJanela(inicioDaJanela(new Date(AGORA.getTime() + 10 * H), AGORA)).getTime()).toBeLessThanOrEqual(AGORA.getTime() + JANELA_ATENDIMENTO_MS);
  });

  it("reentrega tardia usa o instante ORIGINAL: não reabre uma janela vencida", () => {
    // Mensagem de 30 h atrás reentregue agora pela Meta (reentregas duram até 7 dias).
    expect(mensagemAindaAbreJanela(inicioDaJanela(menos(30 * H), AGORA), AGORA)).toBe(false);
    expect(mensagemAindaAbreJanela(inicioDaJanela(menos(H), AGORA), AGORA)).toBe(true);
  });
});

describe("texto livre — validação e hash de idempotência", () => {
  it("apara as pontas; vazio e só espaços são recusados", () => {
    expect(validarTextoLivre("  Olá, tudo bem?\n")).toBe("Olá, tudo bem?");
    for (const t of ["", "   ", "\n\t \n"]) expect(() => validarTextoLivre(t)).toThrow();
  });

  it(`limite de ${LIMITE_TEXTO_LIVRE_WHATSAPP} caracteres (depois de aparar)`, () => {
    expect(validarTextoLivre("a".repeat(LIMITE_TEXTO_LIVRE_WHATSAPP))).toHaveLength(LIMITE_TEXTO_LIVRE_WHATSAPP);
    expect(validarTextoLivre(`  ${"a".repeat(LIMITE_TEXTO_LIVRE_WHATSAPP)}  `)).toHaveLength(LIMITE_TEXTO_LIVRE_WHATSAPP);
    expect(() => validarTextoLivre("a".repeat(LIMITE_TEXTO_LIVRE_WHATSAPP + 1))).toThrow();
  });

  it("aceita quebras de linha, tabulação, acentos e emoji; recusa caracteres de controle e surrogate isolado", () => {
    expect(validarTextoLivre("Linha 1\nLinha 2\r\n\tAção ✅ 😀")).toBe("Linha 1\nLinha 2\r\n\tAção ✅ 😀");
    for (const t of ["oi\u0000", "oi\u0007tchau", "a\u001Bb", "x\u007F", "a\uD83Db", "a\uDE00b"]) {
      expect(() => validarTextoLivre(t)).toThrow();
    }
  });

  it("o erro é VALIDATION_ERROR no campo texto (nada é gravado nem enviado)", () => {
    try {
      validarTextoLivre("   ");
      throw new Error("deveria ter lançado");
    } catch (e) {
      expect(e).toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });

  it("hash: mesmo destinatário + mesmo texto = mesmo hash; muda com texto ou destinatário; nunca colide com template", () => {
    const id = "65f1a2b3c4d5e6f7a8b9c0d1";
    expect(hashConteudoTexto(id, "Olá")).toBe(hashConteudoTexto(id, "Olá"));
    expect(hashConteudoTexto(id, "Olá")).not.toBe(hashConteudoTexto(id, "Olá!"));
    expect(hashConteudoTexto(id, "Olá")).not.toBe(hashConteudoTexto("65f1a2b3c4d5e6f7a8b9c0d2", "Olá"));
    expect(hashConteudoTexto(id, "aniversario_v2")).not.toBe(
      hashConteudoEnvio({ idempotencyKey: "k", destinatario: { tipo: "CLIENTE", id }, template: "aniversario_v2" }),
    );
  });
});
