import { describe, expect, it } from "bun:test";
import { conferirIdentidade, planoIdentidade, type FatosIdentidade } from "./identidade.js";
import { PRIVILEGIOS_GUARDIAO, PRIVILEGIOS_RESTORE, RESTORE } from "./politica.js";
import { exigeTravaAdministrativa } from "./trava.js";

/** Fase 60.4.3.4.21.2.11 (N3, N1) — identidade protegida e trava administrativa (PUROS, sem MongoDB). */

const ID = "5b79d74d-0000-4000-8000-000000000001";
const OUTRO = "5b79d74d-0000-4000-8000-000000000002";
const f = (mud: Partial<FatosIdentidade> = {}): FatosIdentidade => ({ documentos: [{ _id: "instancia", instanciaId: ID }], congelada: true, local: ID, ...mud });

describe("N3 — conferência da identidade (toda operação)", () => {
  it("um documento, igual à cópia local, coleção congelada ⇒ ok", () => expect(conferirIdentidade(f())).toEqual({ ok: true, instanciaId: ID }));
  it("coleção NÃO congelada (guardião descongelou) ⇒ recusa", () => expect(conferirIdentidade(f({ congelada: false })).ok).toBe(false));
  it("documento REMOVIDO (coleção dropada pelo guardião) ⇒ recusa", () => {
    expect(conferirIdentidade(f({ documentos: null, congelada: false })).ok).toBe(false);
    expect(conferirIdentidade(f({ documentos: [] })).ok).toBe(false);
  });
  it("documento EXTRA inserido (restore) ⇒ recusa", () => expect(conferirIdentidade(f({ documentos: [{ _id: "instancia", instanciaId: ID }, { _id: "x", instanciaId: ID }] })).ok).toBe(false));
  it("documento com forma inesperada ⇒ recusa", () => {
    expect(conferirIdentidade(f({ documentos: [{ _id: "outro", instanciaId: ID }] })).ok).toBe(false);
    expect(conferirIdentidade(f({ documentos: [{ _id: "instancia", instanciaId: 42 }] })).ok).toBe(false);
  });
  it("diferente da cópia local / cópia local ausente ⇒ recusa", () => {
    expect(conferirIdentidade(f({ local: OUTRO })).ok).toBe(false);
    expect(conferirIdentidade(f({ local: null })).ok).toBe(false);
  });
});

describe("N3 — plano do configurar-autenticacao (recuperação segura)", () => {
  it("íntegra e protegida ⇒ OK (idempotente)", () => expect(planoIdentidade(f()).acao).toBe("OK"));
  it("íntegra SEM proteção ⇒ PROTEGER (nunca troca o id)", () => expect(planoIdentidade(f({ congelada: false }))).toMatchObject({ acao: "PROTEGER", instanciaId: ID }));
  it("instância nova (nada em lugar nenhum) ⇒ CRIAR", () => expect(planoIdentidade(f({ documentos: null, congelada: false, local: null })).acao).toBe("CRIAR"));
  it("cópia local ausente, instância com identidade ⇒ CRIAR_COPIA_LOCAL a partir da instância", () => expect(planoIdentidade(f({ local: null }))).toMatchObject({ acao: "CRIAR_COPIA_LOCAL", instanciaId: ID }));
  it("documento REMOVIDO, cópia local presente ⇒ RECUSAR sem pedido explícito; RESTAURAR com -RestaurarIdentidadeLocal", () => {
    expect(planoIdentidade(f({ documentos: [], congelada: true })).acao).toBe("RECUSAR");
    expect(planoIdentidade(f({ documentos: null, congelada: false })).acao).toBe("RECUSAR");
    expect(planoIdentidade(f({ documentos: null, congelada: false }), { restaurarDaCopiaLocal: true })).toMatchObject({ acao: "RESTAURAR_DA_COPIA_LOCAL", instanciaId: ID });
  });
  it("divergência, documento extra, forma inesperada, cópia local malformada ⇒ RECUSAR (mesmo com pedido explícito)", () => {
    for (const x of [f({ local: OUTRO }), f({ documentos: [{ _id: "instancia", instanciaId: ID }, { _id: "y" }] }), f({ documentos: [{ _id: "instancia", instanciaId: "nao-uuid" }] }), f({ local: "lixo" })])
      expect(planoIdentidade(x, { restaurarDaCopiaLocal: true }).acao).toBe("RECUSAR");
  });
});

describe("N3 — nenhum privilégio adicional; o que continua possível é documentado", () => {
  const sobreIdentidade = (privs: readonly { resource: object; actions: readonly string[] }[]) =>
    privs.filter((p) => {
      const r = p.resource as Record<string, unknown>;
      return r["db"] === RESTORE.identidade.banco || r["collection"] === RESTORE.identidade.colecao;
    });
  it("nenhum papel operacional tem privilégio ESPECÍFICO na identidade", () => {
    expect(sobreIdentidade(PRIVILEGIOS_RESTORE)).toEqual([]);
    expect(sobreIdentidade(PRIVILEGIOS_GUARDIAO)).toEqual([]);
  });
  it("limite documentado: guardião ainda tem collMod/dropCollection em qualquer banco (detectado, não impedido)", () => {
    const geral = PRIVILEGIOS_GUARDIAO.find((p) => (p.resource as Record<string, unknown>)["db"] === "" && (p.resource as Record<string, unknown>)["collection"] === "")!;
    expect(geral.actions).toContain("collMod");
    expect(geral.actions).toContain("dropCollection");
    expect(PRIVILEGIOS_RESTORE.some((p) => (p.actions as readonly string[]).includes("bypassDocumentValidation"))).toBe(false);
  });
});

describe("N1 — trava exigida nas operações administrativas da CLI", () => {
  it("27118 exige; 27119 (origem sintética dos testes) não", () => {
    expect(exigeTravaAdministrativa(27118)).toBe(true);
    expect(exigeTravaAdministrativa("27118")).toBe(true);
    expect(exigeTravaAdministrativa(27119)).toBe(false);
  });
});
