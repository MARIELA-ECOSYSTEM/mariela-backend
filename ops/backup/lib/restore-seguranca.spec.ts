import { describe, expect, it } from "bun:test";
import { Int32 } from "bson";
import { especificacaoIndice, opcoesComparaveis } from "./archive.js";
import { conferirAncora, estadosAdmitidos, lerCadeia, proximaLinha, type EventoAncora, type FatosAtuais } from "./ancora.js";
import { compararEspecificacoes, compararOpcoesColecao } from "./integridade.js";
import { ESTADOS_DESTINO, garantiasDoEstado, PRIVILEGIOS_GUARDIAO, PRIVILEGIOS_RESTORE, transicaoPermitida, TRANSICOES_DESTINO, type EstadoDestino } from "./politica.js";
import { COLECAO_POSSE, colecoesAlheias, conferirIdentidadePosse, decidirTransicao, ESTADOS_POR_MODO, estaCongelada, mesmasEvidencias, planoDeLimpeza, VALIDADOR_CONGELADO } from "./posse.js";

/**
 * Fase 60.4.3.4.21.2.8 — testes PUROS (sem MongoDB, sem rede, sem arquivos) das correções da auditoria 21.2.7.
 * Provam a LÓGICA de decisão. O comportamento do SERVIDOR (o que o listCollections devolve, o que o validador bloqueia,
 * a atomicidade do CAS) NÃO é provado aqui — fica para a validação integrada com MongoDB descartável.
 */

describe("A21-7-01 — congelamento completo (validador + nível + ação)", () => {
  const completo = { validator: VALIDADOR_CONGELADO, validationLevel: "strict", validationAction: "error" };
  it("validador + strict + error ⇒ congelado", () => expect(estaCongelada({ opcoes: completo })).toBe(true));
  it("números do validador como Int32 (como o driver pode devolver) ⇒ ainda congelado (igualdade estrutural)", () => {
    expect(estaCongelada({ opcoes: { ...completo, validator: { $expr: { $eq: [new Int32(1), new Int32(0)] } } } })).toBe(true);
  });
  it("validationAction: 'warn' ⇒ NÃO congelado", () => expect(estaCongelada({ opcoes: { ...completo, validationAction: "warn" } })).toBe(false));
  it("validationLevel: 'off' ⇒ NÃO congelado", () => expect(estaCongelada({ opcoes: { ...completo, validationLevel: "off" } })).toBe(false));
  it("validationLevel: 'moderate' ⇒ NÃO congelado", () => expect(estaCongelada({ opcoes: { ...completo, validationLevel: "moderate" } })).toBe(false));
  it("validationAction ausente ⇒ NÃO congelado", () => {
    const { validationAction: _, ...sem } = completo;
    expect(estaCongelada({ opcoes: sem })).toBe(false);
  });
  it("validationLevel ausente ⇒ NÃO congelado", () => {
    const { validationLevel: _, ...sem } = completo;
    expect(estaCongelada({ opcoes: sem })).toBe(false);
  });
  it("validador ausente, vazio ou diferente ⇒ NÃO congelado", () => {
    expect(estaCongelada({ opcoes: { validationLevel: "strict", validationAction: "error" } })).toBe(false);
    expect(estaCongelada({ opcoes: { ...completo, validator: {} } })).toBe(false);
    expect(estaCongelada({ opcoes: { ...completo, validator: { $expr: { $eq: [1, 1] } } } })).toBe(false);
  });
  it("opções ilegíveis/ausentes ⇒ NÃO congelado (falha fechada)", () => {
    expect(estaCongelada({ opcoes: {} })).toBe(false);
    expect(estaCongelada({ opcoes: undefined as never })).toBe(false);
  });
});

describe("A21-7-01 — separação de papéis (nenhum usuário descongela E escreve dados)", () => {
  const acoes = (privs: readonly { resource: object; actions: readonly string[] }[], recurso: (r: Record<string, unknown>) => boolean) =>
    new Set(privs.filter((p) => recurso(p.resource as Record<string, unknown>)).flatMap((p) => [...p.actions]));
  const dados = (r: Record<string, unknown>) => r["db"] === "" && r["collection"] === "";
  it("restore: escreve dados, mas SEM collMod, dropCollection, update, remove, bypass", () => {
    const a = acoes(PRIVILEGIOS_RESTORE, dados);
    expect(a.has("insert")).toBe(true);
    for (const proibida of ["collMod", "dropCollection", "update", "remove", "bypassDocumentValidation", "dropDatabase", "renameCollectionSameDB"]) expect(a.has(proibida)).toBe(false);
    expect(PRIVILEGIOS_RESTORE.some((p) => (p.resource as Record<string, unknown>)["collection"] === COLECAO_POSSE)).toBe(false);
  });
  it("guardião: collMod/dropCollection, mas SEM insert/update/remove/createIndex em dados e SEM bypass", () => {
    const a = acoes(PRIVILEGIOS_GUARDIAO, dados);
    expect(a.has("collMod") && a.has("dropCollection")).toBe(true);
    for (const proibida of ["insert", "update", "remove", "createIndex", "bypassDocumentValidation", "dropDatabase"]) expect(a.has(proibida)).toBe(false);
    const posse = acoes(PRIVILEGIOS_GUARDIAO, (r) => r["collection"] === COLECAO_POSSE);
    expect([...posse].sort()).toEqual(["createCollection", "insert", "remove", "update"]);
  });
});

describe("A21-7-03 — índices e opções de coleção completos", () => {
  const base = { v: 2, key: { a: 1, b: -1 }, name: "a_1_b_-1", unique: true };
  const igual = (x: object, y: object) => especificacaoIndice(x).especificacao === especificacaoIndice(y).especificacao;
  it("collation diferente ⇒ divergente", () => expect(igual({ ...base, collation: { locale: "pt", strength: 1 } }, { ...base, collation: { locale: "pt", strength: 2 } })).toBe(false));
  it("hidden ⇒ divergente", () => expect(igual(base, { ...base, hidden: true })).toBe(false));
  it("opções textuais (weights, default_language) ⇒ divergente", () => {
    const t = { v: 2, key: { _fts: "text", _ftsx: 1 }, name: "t", weights: { nome: 1 }, default_language: "portuguese", textIndexVersion: 3 };
    expect(igual(t, { ...t, weights: { nome: 10 } })).toBe(false);
    expect(igual(t, { ...t, default_language: "none" })).toBe(false);
  });
  it("opção geoespacial (2dsphereIndexVersion) ⇒ divergente", () => {
    const g = { v: 2, key: { loc: "2dsphere" }, name: "g", "2dsphereIndexVersion": 3 };
    expect(igual(g, { ...g, "2dsphereIndexVersion": 2 })).toBe(false);
  });
  it("unique, partial, sparse, TTL ⇒ divergentes", () => {
    expect(igual(base, { ...base, unique: false })).toBe(false);
    expect(igual(base, { ...base, partialFilterExpression: { a: { $exists: true } } })).toBe(false);
    expect(igual(base, { ...base, sparse: true })).toBe(false);
    expect(igual({ ...base, expireAfterSeconds: 60 }, { ...base, expireAfterSeconds: 61 })).toBe(false);
  });
  it("ORDEM da chave composta importa; ordem das demais opções não", () => {
    expect(igual(base, { ...base, key: { b: -1, a: 1 } })).toBe(false);
    expect(igual({ name: "x", key: { a: 1 }, collation: { strength: 1, locale: "pt" } }, { collation: { locale: "pt", strength: 1 }, key: { a: 1 }, name: "x" })).toBe(true);
  });
  it("ignorados (sem efeito semântico): v, ns, background; tipo numérico da direção (1 = Int32(1) = 1.0)", () => {
    expect(igual(base, { ...base, v: 1, ns: "x.y", background: true })).toBe(true);
    expect(igual(base, { ...base, key: { a: new Int32(1), b: new Int32(-1) } })).toBe(true);
  });
  it("comparação de conjuntos: mesmo nome com outra opção ⇒ alheio E faltando", () => {
    const r = compararEspecificacoes([especificacaoIndice({ ...base, hidden: true })], [especificacaoIndice(base)], "igual");
    expect(r.ok).toBe(false);
    expect(r.alheios).toEqual(["a_1_b_-1"]);
    expect(r.faltando).toEqual(["a_1_b_-1"]);
    expect(compararEspecificacoes([], [especificacaoIndice(base)], "subconjunto").ok).toBe(true);
  });
  it("opções de coleção: collation padrão diferente ⇒ divergente; trio de validação é ignorado aqui (conferido à parte)", () => {
    expect(compararOpcoesColecao({ collation: { locale: "pt" } }, {}).ok).toBe(false);
    expect(compararOpcoesColecao({ validator: VALIDADOR_CONGELADO, validationLevel: "strict", validationAction: "error" }, {}).ok).toBe(true);
    expect(opcoesComparaveis({ b: 1, a: { d: 1, c: 2 } })).toBe(opcoesComparaveis({ a: { c: 2, d: 1 }, b: 1 }));
  });
  it("evidências: índices ou opções diferentes ⇒ evidências diferentes", () => {
    const e = { documentos: 1, hashesPorColecao: { a: "1" }, uuidsPorColecao: { a: "u" }, indicesHash: "i", opcoesHash: "o" };
    expect(mesmasEvidencias(e, { ...e })).toBe(true);
    expect(mesmasEvidencias(e, { ...e, indicesHash: "x" })).toBe(false);
    expect(mesmasEvidencias(e, { ...e, opcoesHash: "x" })).toBe(false);
  });
});

describe("A21-7-04/05/07 — máquina de estados (REMOVENDO, EM_USO, DESCARTADO)", () => {
  it("todo estado tem transições declaradas e só para estados conhecidos", () => {
    for (const e of ESTADOS_DESTINO) for (const p of TRANSICOES_DESTINO[e]) expect(ESTADOS_DESTINO).toContain(p);
  });
  it("remoção SEMPRE passa por REMOVENDO (nunca direto ao estado final)", () => {
    for (const e of ESTADOS_DESTINO) if (e !== "REMOVENDO") {
      expect(transicaoPermitida(e, "CANCELADO_COM_LIMPEZA_COMPROVADA")).toBe(false);
      expect(transicaoPermitida(e, "DESCARTADO")).toBe(false);
    }
    expect(transicaoPermitida("VERIFICADO", "REMOVENDO")).toBe(true);
    expect(transicaoPermitida("REMOVENDO", "CANCELADO_COM_LIMPEZA_COMPROVADA")).toBe(true);
    expect(transicaoPermitida("REMOVENDO", "INTERVENCAO_NECESSARIA")).toBe(true);
    expect(transicaoPermitida("REMOVENDO", "VERIFICADO")).toBe(false); // nunca volta a "íntegro"
  });
  it("uso só depois da liberação; uso nunca volta a íntegro", () => {
    expect(transicaoPermitida("LIBERACAO_AUTORIZADA", "EM_USO")).toBe(true);
    expect(transicaoPermitida("VERIFICADO", "EM_USO")).toBe(false);
    for (const p of ["VERIFICADO", "LIBERACAO_AUTORIZADA", "VALIDANDO"] as EstadoDestino[]) expect(transicaoPermitida("EM_USO", p)).toBe(false);
  });
  it("garantias: só VERIFICADO e LIBERACAO_AUTORIZADA afirmam igualdade e proteção; EM_USO não", () => {
    expect(garantiasDoEstado("VERIFICADO")).toEqual({ igualAoArchive: true, protegido: true, utilizavel: false });
    expect(garantiasDoEstado("LIBERACAO_AUTORIZADA")).toEqual({ igualAoArchive: true, protegido: true, utilizavel: false });
    expect(garantiasDoEstado("EM_USO")).toEqual({ igualAoArchive: false, protegido: false, utilizavel: true });
    for (const e of ["REMOVENDO", "INTERVENCAO_NECESSARIA", "FALHOU_DESTINO_PARCIAL"] as EstadoDestino[]) expect(garantiasDoEstado(e).igualAoArchive).toBe(false);
  });
  it("decisão de transição respeita o estado de origem exigido", () => {
    expect(decidirTransicao("VERIFICADO", "LIBERACAO_AUTORIZADA", ["VERIFICADO"]).ok).toBe(true);
    expect(decidirTransicao("INTERVENCAO_NECESSARIA", "LIBERACAO_AUTORIZADA", ["VERIFICADO"]).ok).toBe(false);
    expect(decidirTransicao("VERIFICADO", "EM_USO").ok).toBe(false);
  });
  const cs = (...n: string[]) => n.map((nome) => ({ nome, tipo: "collection" }));
  it("CANCELADO com SÓ a coleção de controle ⇒ concluir (A21-7-07); com resíduo ⇒ recusar", () => {
    expect(planoDeLimpeza("CANCELADO_COM_LIMPEZA_COMPROVADA", "recuperacao", cs(COLECAO_POSSE)).acao).toBe("concluir-controle");
    expect(planoDeLimpeza("DESCARTADO", "recuperacao", cs(COLECAO_POSSE)).acao).toBe("concluir-controle");
    const r = planoDeLimpeza("CANCELADO_COM_LIMPEZA_COMPROVADA", "recuperacao", cs(COLECAO_POSSE, "vendas"));
    expect(r.acao).toBe("recusar");
    expect(r.motivo).toBe("RESIDUOS_APOS_ESTADO_FINAL");
    expect(planoDeLimpeza("CANCELADO_COM_LIMPEZA_COMPROVADA", "remocao", cs(COLECAO_POSSE)).motivo).toBe("ESTADO_INCOMPATIVEL");
  });
  it("system.* no destino é alheio (A21-7-08); modos só aceitam seus estados", () => {
    expect(colecoesAlheias(cs("vendas", "system.js", COLECAO_POSSE))).toEqual(["system.js"]);
    expect(colecoesAlheias([{ nome: "vendas", tipo: "view" }])).toEqual(["vendas"]);
    expect(planoDeLimpeza("VERIFICADO", "remocao", cs("vendas", "system.views")).motivo).toBe("COLECOES_ALHEIAS");
    expect(planoDeLimpeza("VERIFICADO", "remocao", cs("vendas", COLECAO_POSSE)).acao).toBe("remover");
    expect(planoDeLimpeza("VERIFICADO", "descarte", cs("vendas")).motivo).toBe("ESTADO_INCOMPATIVEL");
    expect(planoDeLimpeza("EM_USO", "remocao", cs("vendas")).motivo).toBe("ESTADO_INCOMPATIVEL");
    expect(ESTADOS_POR_MODO.recuperacao).toContain("REMOVENDO");
  });
});

describe("A21-7-06 — identidade da posse (execução, banco, instância)", () => {
  const doc = { execucaoId: "e1", banco: "mariela_restore_20260101_000001", instanciaId: "i1", estado: "VERIFICADO" as EstadoDestino };
  const esp = { execucaoId: "e1", banco: "mariela_restore_20260101_000001", instanciaId: "i1" };
  it("mesma execução, banco e instância ⇒ ok", () => expect(conferirIdentidadePosse(doc, esp).ok).toBe(true));
  it("posse copiada para OUTRO banco ⇒ recusada", () => expect(conferirIdentidadePosse(doc, { ...esp, banco: "mariela_restore_20260101_000002" }).ok).toBe(false));
  it("OUTRA instância ⇒ recusada; sem instanciaId ⇒ recusada", () => {
    expect(conferirIdentidadePosse(doc, { ...esp, instanciaId: "i2" }).ok).toBe(false);
    expect(conferirIdentidadePosse({ ...doc, instanciaId: undefined }, esp).ok).toBe(false);
  });
  it("OUTRA execução ⇒ recusada; sem documento ⇒ recusada", () => {
    expect(conferirIdentidadePosse(doc, { ...esp, execucaoId: "e2" }).ok).toBe(false);
    expect(conferirIdentidadePosse(null, esp).ok).toBe(false);
  });
});

describe("A21-7-02 — âncora externa (registro local encadeado)", () => {
  const SHA_A = "A".repeat(64);
  const SHA_M = "B".repeat(64);
  const base = { banco: "mariela_restore_20260101_000001", execucaoId: "e1", instanciaId: "i1" };
  const ev = { documentos: 3, hashesPorColecao: { vendas: "h" }, uuidsPorColecao: { vendas: "u" } };
  const montar = (eventos: Omit<EventoAncora, "banco" | "execucaoId" | "instanciaId">[]) => {
    let t = "";
    for (const e of eventos) t += `${proximaLinha(t, { ...base, ...e } as EventoAncora)}\n`;
    return t;
  };
  const normal = () =>
    montar([
      { evento: "POSSE", archive: { caminho: "C:\\b\\x.archive.gz", sha256: SHA_A }, manifesto: { caminho: "C:\\b\\x.manifest.json", sha256: SHA_M } },
      { evento: "INTENCAO", de: "PREPARANDO", para: "RESTAURANDO" },
      { evento: "CONFIRMACAO", de: "PREPARANDO", para: "RESTAURANDO" },
      { evento: "INTENCAO", de: "RESTAURANDO", para: "VALIDANDO" },
      { evento: "CONFIRMACAO", de: "RESTAURANDO", para: "VALIDANDO" },
      { evento: "EVIDENCIAS", evidencias: ev },
      { evento: "INTENCAO", de: "VALIDANDO", para: "VERIFICADO" },
      { evento: "CONFIRMACAO", de: "VALIDANDO", para: "VERIFICADO" },
    ]);
  const fatos = (mud: Partial<FatosAtuais> = {}, posseMud: Partial<NonNullable<FatosAtuais["posse"]>> = {}): FatosAtuais => ({
    banco: base.banco,
    instanciaId: "i1",
    posse: { execucaoId: "e1", estado: "VERIFICADO", banco: base.banco, instanciaId: "i1", archiveSha256: SHA_A, manifestoSha256: SHA_M, archive: "C:\\b\\x.archive.gz", manifesto: "C:\\b\\x.manifest.json", evidencias: ev, ...posseMud },
    archiveInformado: { caminho: "C:\\b\\x.archive.gz", sha256: SHA_A },
    manifestoInformado: { caminho: "C:\\b\\x.manifest.json", sha256: SHA_M },
    shaDoArquivoSha256: SHA_A,
    shaDoManifesto: SHA_A,
    ...mud,
  });
  const falhas = (v: { id: string; ok: boolean }[]) => v.filter((x) => !x.ok).map((x) => x.id);

  it("registro íntegro + posse e arquivos coerentes ⇒ tudo confere", () => expect(falhas(conferirAncora(normal(), fatos()))).toEqual([]));
  it("registro AUSENTE ⇒ recusa", () => expect(falhas(conferirAncora(null, fatos()))).toEqual(["ancora.presente"]));
  it("linha do registro EDITADA no meio ⇒ cadeia quebrada", () => {
    const linhas = normal().split("\n");
    linhas[2] = linhas[2]!.replace("RESTAURANDO", "VERIFICADO");
    expect(falhas(conferirAncora(linhas.join("\n"), fatos()))).toEqual(["ancora.cadeia"]);
  });
  // Fase 21.2.11 (X1): ids granulares — registro×posse (…_registro) separado de informado×registro e de artefatos do backup.
  it("posse com SHA do archive adulterado ⇒ recusa", () => expect(falhas(conferirAncora(normal(), fatos({}, { archiveSha256: "C".repeat(64) })))).toEqual(["ancora.archive_registro"]));
  it("posse com SHA do manifesto adulterado ⇒ recusa", () => expect(falhas(conferirAncora(normal(), fatos({}, { manifestoSha256: "C".repeat(64) })))).toEqual(["ancora.manifesto_registro"]));
  it("posse com CAMINHOS trocados ⇒ recusa", () => expect(falhas(conferirAncora(normal(), fatos({}, { archive: "C:\\outro\\y.archive.gz" })))).toContain("ancora.caminhos"));
  it("archive INFORMADO diferente (outro backup) ⇒ recusa", () => expect(falhas(conferirAncora(normal(), fatos({ archiveInformado: { caminho: "x", sha256: "D".repeat(64) } })))).toContain("ancora.archive"));
  it(".sha256 do diretório de backup divergente ⇒ recusa", () => expect(falhas(conferirAncora(normal(), fatos({ shaDoArquivoSha256: "E".repeat(64) })))).toEqual(["ancora.archive_sha256"]));
  it("manifesto que descreve OUTRO archive ⇒ recusa", () => expect(falhas(conferirAncora(normal(), fatos({ shaDoManifesto: "E".repeat(64) })))).toEqual(["ancora.archive_manifesto"]));
  it("posse com ESTADO adulterado (LIBERACAO sem registro) ⇒ recusa", () => expect(falhas(conferirAncora(normal(), fatos({}, { estado: "LIBERACAO_AUTORIZADA" })))).toContain("ancora.estado"));
  it("posse com EVIDÊNCIAS adulteradas ⇒ recusa", () => expect(falhas(conferirAncora(normal(), fatos({}, { evidencias: { ...ev, hashesPorColecao: { vendas: "x" } } })))).toContain("ancora.evidencias"));
  it("posse de OUTRO banco / OUTRA instância / OUTRA execução ⇒ recusa", () => {
    expect(falhas(conferirAncora(normal(), fatos({}, { banco: "mariela_restore_20260101_000009" })))).toContain("ancora.posse_banco");
    expect(falhas(conferirAncora(normal(), fatos({ banco: "mariela_restore_20260101_000009" })))).toContain("ancora.banco");
    expect(falhas(conferirAncora(normal(), fatos({ instanciaId: "i9" })))).toContain("ancora.instancia");
    expect(falhas(conferirAncora(normal(), fatos({ instanciaId: "i9" })))).toContain("ancora.posse_instancia");
    expect(falhas(conferirAncora(normal(), fatos({}, { execucaoId: "e9" })))).toContain("ancora.execucao");
  });
  it("queda entre INTENÇÃO e CONFIRMAÇÃO: banco no 'de' OU no 'para' é admitido; outro estado não", () => {
    // 21.2.11: o registro é montado UMA vez (normal() chamado duas vezes dava carimbos de tempo diferentes ⇒ teste instável).
    const n = normal();
    const t = n + `${proximaLinha(n, { ...base, evento: "INTENCAO", de: "VERIFICADO", para: "REMOVENDO" })}\n`;
    expect(estadosAdmitidos(lerCadeia(t).entradas)).toEqual(["VERIFICADO", "REMOVENDO"]);
    expect(falhas(conferirAncora(t, fatos({}, { estado: "REMOVENDO" })))).toEqual([]);
    expect(falhas(conferirAncora(t, fatos({}, { estado: "VERIFICADO" })))).toEqual([]);
    expect(falhas(conferirAncora(t, fatos({}, { estado: "LIBERACAO_AUTORIZADA" })))).toContain("ancora.estado");
  });
  it("registro que não começa pela posse, ou mistura execuções ⇒ inválido", () => {
    expect(lerCadeia(montar([{ evento: "INTENCAO", de: "PREPARANDO", para: "RESTAURANDO" }])).ok).toBe(false);
    const n = normal();
    const misturado = n + `${proximaLinha(n, { ...base, execucaoId: "e2", evento: "INTENCAO", de: "VERIFICADO", para: "REMOVENDO" })}\n`;
    expect(lerCadeia(misturado).ok).toBe(false);
  });
});
