import { describe, expect, it } from "bun:test";
import { lerArchive, type IndiceNormalizado } from "./archive.js";
import type { Assinatura } from "./janela.js";
import { montarManifesto, validarArchiveParaRestore, validarBackup, verificarVersaoDestino, type PreBackup } from "./manifesto.js";
import { BANCO_ORIGEM, COLECOES_BACKUP } from "./politica.js";
import { montarArchive } from "./teste-archive.util.js";

/** Fase 60.4.3.4.21.2 — validade do backup é FALHA FECHADA: qualquer validação falha ⇒ INVALIDO. */

const ID: IndiceNormalizado = { nome: "_id_", chave: '{"_id":1}', unique: false, parcial: null, sparse: false, ttl: null };
const assinatura = (produtos = 2): Assinatura =>
  Object.fromEntries(
    COLECOES_BACKUP.map((c) => [c, { estrategia: "timestamp" as const, contagem: c === "produtos" ? produtos : 0, maiorTimestamp: c === "produtos" ? "2026-11-09T20:00:00.000Z" : null, hashConteudo: null }]),
  );

function pre(parcial: Partial<PreBackup> = {}): PreBackup {
  return {
    elegivel: true,
    motivo: "ELEGIVEL",
    agora: "2026-11-09T23:50:00.000Z",
    versaoServidor: "8.0.37",
    verificacoes: [],
    informacoes: {},
    colecoesExistentes: [],
    exclusoes: [],
    assinatura: assinatura(),
    indices: Object.fromEntries(COLECOES_BACKUP.map((c) => [c, [ID]])),
    referencias: {},
    sequencias: {},
    ...parcial,
  };
}
const archive = (versao = "8.0.37", produtos = 2) =>
  lerArchive(montarArchive({ versaoServidor: versao, colecoes: COLECOES_BACKUP.map((c) => ({ db: BANCO_ORIGEM, colecao: c, docs: c === "produtos" ? Array.from({ length: produtos }, (_, i) => ({ i })) : [] })) }));

function manifesto(validacoes: ReturnType<typeof validarBackup>["validacoes"], comArchive = true) {
  return montarManifesto({
    execucaoId: "e",
    tipo: "diario",
    iniciadoEm: "2026-11-09T23:50:00-03:00",
    concluidoEm: "2026-11-09T23:51:00-03:00",
    dataLocal: "2026-11-09",
    fusoHorario: "E. South America Standard Time",
    ferramentas: { mongodump: "100.17.0" },
    servidor: { versao: "8.0.37" },
    origem: { banco: BANCO_ORIGEM },
    janela: { verificacoes: [], informacoes: {} },
    assinaturaAntes: null,
    assinaturaDepois: assinatura(),
    indices: null,
    referencias: null,
    sequencias: null,
    archive: comArchive ? { arquivo: "a", tamanhoBytes: 1, sha256: "A", versaoServidor: "8.0.37", versaoFerramenta: "100.17.0", documentosPorColecao: Object.fromEntries(COLECOES_BACKUP.map((c) => [c, c === "produtos" ? 2 : 0])) } : null,
    validacoes,
    avisos: [],
  });
}

describe("validarBackup / montarManifesto", () => {
  it("origem estável + archive conforme → todas as validações OK → VALIDO_LOCAL", () => {
    const { validacoes } = validarBackup(pre(), assinatura(), archive());
    expect(validacoes.filter((v) => !v.ok)).toEqual([]);
    const m = manifesto(validacoes);
    expect(m.estado).toBe("VALIDO_LOCAL");
    expect(m.consistencia).toContain("não é snapshot transacional");
    expect(m.politica.colecoesExcluidas).toEqual(["refresh_tokens", "vendedor_refresh_tokens"]);
  });

  it("escrita durante o dump (assinatura depois ≠ antes) → INVALIDO", () => {
    const { validacoes } = validarBackup(pre(), assinatura(3), archive());
    expect(validacoes.find((v) => v.id === "consistencia.assinaturas_iguais")?.ok).toBe(false);
    expect(manifesto(validacoes).estado).toBe("INVALIDO");
  });

  it("contagem do archive ≠ origem, índices diferentes, versão diferente ou pré-backup não elegível → INVALIDO", () => {
    expect(validarBackup(pre(), assinatura(), archive("8.0.37", 1)).validacoes.find((v) => v.id === "archive.contagens_iguais_origem")?.ok).toBe(false);
    const outrosIndices = pre({ indices: { ...pre().indices!, vendas: [ID, { ...ID, nome: "x_1", chave: '{"x":1}' }] } });
    expect(validarBackup(outrosIndices, assinatura(), archive()).validacoes.find((v) => v.id === "archive.indices_iguais_origem")?.ok).toBe(false);
    expect(validarBackup(pre(), assinatura(), archive("8.0.36")).validacoes.find((v) => v.id === "archive.versao_igual_origem")?.ok).toBe(false);
    expect(validarBackup(pre({ elegivel: false, motivo: "ADIADO" }), assinatura(), archive()).validacoes.find((v) => v.id === "pre.elegivel")?.ok).toBe(false);
  });

  it("sem archive ou sem validações → INVALIDO (nunca válido por omissão)", () => {
    expect(manifesto([{ id: "x", ok: true, detalhe: "" }], false).estado).toBe("INVALIDO");
    expect(manifesto([]).estado).toBe("INVALIDO");
  });

  it("avisos não mudam o estado", () => {
    const r = validarBackup(pre({ sequencias: { venda: { valor: 1, maiorEmitido: 2, ok: false } }, referencias: { "x→y": 1 } }), assinatura(), archive());
    expect(r.avisos.join(" ")).toContain("sequências");
    expect(manifesto(r.validacoes).estado).toBe("VALIDO_LOCAL");
  });
});

describe("restore: archive × manifesto e versão do destino", () => {
  it("archive conforme o manifesto → ok; contagem divergente → recusa", () => {
    const m = manifesto(validarBackup(pre(), assinatura(), archive()).validacoes);
    expect(validarArchiveParaRestore(archive(), m).every((v) => v.ok)).toBe(true);
    expect(validarArchiveParaRestore(archive("8.0.37", 5), m).find((v) => v.id === "archive.contagens_iguais_manifesto")?.ok).toBe(false);
  });

  it("versão: mesma série 8.0 aceita (correção diferente é registrada); 8.2 ou desconhecida → recusa", () => {
    expect(verificarVersaoDestino("8.0.37", "8.0.37").ok).toBe(true);
    expect(verificarVersaoDestino("8.0.37", "8.0.36")).toMatchObject({ ok: true });
    expect(verificarVersaoDestino("8.0.37", "8.0.36").detalhe).toContain("correção diferente");
    expect(verificarVersaoDestino("8.0.37", "8.2.1").ok).toBe(false);
    expect(verificarVersaoDestino(null, "8.0.37").ok).toBe(false);
  });
});
