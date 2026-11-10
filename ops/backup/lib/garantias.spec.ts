import { describe, expect, it } from "bun:test";
import { garantiasEfetivas, type FatosGarantias } from "./garantias.js";
import { ESTADOS_DESTINO, garantiasDoEstado } from "./politica.js";

/** Fase 60.4.3.4.21.2.11 (D14/N4) — garantias efetivas × declaradas (PURA, sem MongoDB). */

const ok = (mud: Partial<FatosGarantias> = {}): FatosGarantias => ({
  estado: "VERIFICADO",
  documentosDePosse: 1,
  identidadePosseOk: true,
  identidadeInstanciaOk: true,
  ancora: { presente: true, cadeiaOk: true, estadoAdmitido: true, erro: null },
  congeladas: 27,
  colecoesDeDados: 27,
  ...mud,
});
const nada = { igualAoArchive: false, protegido: false, utilizavel: false };

describe("N4 — Inspecionar (sem reverificação)", () => {
  it("VERIFICADO com âncora válida: protegido COMPROVADO; igual ao archive DECLARADO, NÃO reverificado (efetivo falso)", () => {
    const g = garantiasEfetivas(ok());
    expect(g.declaradas).toEqual(garantiasDoEstado("VERIFICADO"));
    expect(g.efetivas).toEqual({ igualAoArchive: false, protegido: true, utilizavel: false });
    expect(g.situacao.igualAoArchive.situacao).toBe("DECLARADA_NAO_REVERIFICADA");
    expect(g.situacao.protegido.situacao).toBe("COMPROVADA");
    expect(g.situacao.utilizavel.situacao).toBe("NAO_SE_APLICA");
    expect([g.divergenciaNaoRegistravel, g.intervencaoPersistida]).toEqual([false, false]);
  });
  it("VERIFICADO com âncora CORROMPIDA ⇒ nenhuma garantia; divergência não registrável", () => {
    const g = garantiasEfetivas(ok({ ancora: { presente: true, cadeiaOk: false, estadoAdmitido: false } }));
    expect(g.efetivas).toEqual(nada);
    expect(g.situacao.protegido.situacao).toBe("INDISPONIVEL");
    expect(g.indisponiveisPor.join()).toContain("cadeia inválida");
    expect(g.divergenciaNaoRegistravel).toBe(true);
  });
  it("âncora AUSENTE ⇒ nenhuma garantia", () => {
    const g = garantiasEfetivas(ok({ ancora: { presente: false, cadeiaOk: false, estadoAdmitido: false } }));
    expect([g.efetivas, g.divergenciaNaoRegistravel]).toEqual([nada, true]);
  });
  it("falha de LEITURA da âncora ⇒ nenhuma garantia, motivo explícito", () => {
    const g = garantiasEfetivas(ok({ ancora: { presente: false, cadeiaOk: false, estadoAdmitido: false, erro: "EACCES" } }));
    expect(g.efetivas).toEqual(nada);
    expect(g.indisponiveisPor.join()).toContain("ilegível (EACCES)");
  });
  it("estado da posse NÃO admitido pelo registro ⇒ nenhuma garantia (mas a âncora aceita registrar)", () => {
    const g = garantiasEfetivas(ok({ ancora: { presente: true, cadeiaOk: true, estadoAdmitido: false } }));
    expect([g.efetivas, g.divergenciaNaoRegistravel]).toEqual([nada, false]);
  });
  it("identidade da instância DIVERGENTE ou AUSENTE ⇒ nenhuma garantia", () => {
    const g = garantiasEfetivas(ok({ identidadeInstanciaOk: false, identidadePosseOk: false }));
    expect(g.efetivas).toEqual(nada);
    expect(g.indisponiveisPor).toContain("identidade da instância não comprovada");
  });
  it("posse inválida (outra execução/banco/instância) ou não única ⇒ nenhuma garantia", () => {
    expect(garantiasEfetivas(ok({ identidadePosseOk: false })).efetivas).toEqual(nada);
    expect(garantiasEfetivas(ok({ documentosDePosse: 2 })).efetivas).toEqual(nada);
  });
  it("proteção incompleta (uma coleção descongelada) ⇒ protegido INDISPONIVEL", () => {
    const g = garantiasEfetivas(ok({ congeladas: 26 }));
    expect(g.efetivas.protegido).toBe(false);
    expect(g.situacao.protegido.motivo).toContain("26/27");
  });
  it("estado NÃO reconhecido ⇒ sem declaração, nenhuma garantia", () => {
    const g = garantiasEfetivas(ok({ estado: "LIBERADO_TALVEZ" }));
    expect([g.declaradas, g.efetivas]).toEqual([null, nada]);
    expect(g.indisponiveisPor.join()).toContain("estado desconhecido");
  });
  it("sem posse ⇒ nenhuma garantia", () => expect(garantiasEfetivas(ok({ estado: null, documentosDePosse: 0, identidadePosseOk: false })).efetivas).toEqual(nada));
  it("EM_USO válido ⇒ só utilizável; INTERVENCAO ⇒ nenhuma, intervenção persistida", () => {
    expect(garantiasEfetivas(ok({ estado: "EM_USO", congeladas: 0 })).efetivas).toEqual({ igualAoArchive: false, protegido: false, utilizavel: true });
    const i = garantiasEfetivas(ok({ estado: "INTERVENCAO_NECESSARIA" }));
    expect([i.efetivas, i.intervencaoPersistida]).toEqual([nada, true]);
  });
  it("efetivas NUNCA excedem as declaradas, em qualquer estado e combinação", () => {
    for (const e of ESTADOS_DESTINO)
      for (const rev of [undefined, true, false])
        for (const anc of [true, false]) {
          const g = garantiasEfetivas(ok({ estado: e, reverificacaoOk: rev, ancora: { presente: true, cadeiaOk: anc, estadoAdmitido: anc } }));
          for (const n of ["igualAoArchive", "protegido", "utilizavel"] as const) if (g.efetivas[n]) expect(g.declaradas![n]).toBe(true);
        }
  });
});

describe("N4 — Verificar (com reverificação completa)", () => {
  it("reverificação OK ⇒ igual ao archive COMPROVADO", () => {
    const g = garantiasEfetivas(ok({ reverificacaoOk: true }));
    expect(g.efetivas).toEqual({ igualAoArchive: true, protegido: true, utilizavel: false });
    expect(g.situacao.igualAoArchive.situacao).toBe("COMPROVADA");
  });
  it("reverificação REPROVADA ⇒ nenhuma garantia (antes: o estado VERIFICADO ainda era devolvido como garantia)", () => {
    const g = garantiasEfetivas(ok({ reverificacaoOk: false }));
    expect(g.efetivas).toEqual(nada);
    expect(g.indisponiveisPor).toContain("reverificação completa reprovada");
  });
});
