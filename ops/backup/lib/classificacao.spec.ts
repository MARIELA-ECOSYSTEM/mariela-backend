import { describe, expect, it } from "bun:test";
import type { Verificacao } from "./archive.js";
import { conferirAncora, proximaLinha, type EventoAncora, type FatosAtuais } from "./ancora.js";
import { CATEGORIA_POR_VERIFICACAO, classificarExcecao, classificarFalhas, operarComReverificacao, type PortasReverificacao } from "./classificacao.js";
import type { EstadoDestino } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2.11 (X1) — classificação de falhas de Liberar/IniciarUso. PUROS + armazenamento FALSO em memória
 * (sem MongoDB, sem arquivos): provam a decisão e o estado ANTES/DEPOIS. A atomicidade do CAS e a escrita real na
 * âncora não são provadas aqui (ver testes-posse/integração, que exigem MongoDB descartável).
 */

const SHA_A = "A".repeat(64);
const SHA_M = "B".repeat(64);
const OUTRO = "D".repeat(64);
const base = { banco: "mariela_restore_20260101_000001", execucaoId: "e1", instanciaId: "i1" };
const ev = { documentos: 3, hashesPorColecao: { vendas: "h" }, uuidsPorColecao: { vendas: "u" } };

function registro(final: EstadoDestino = "VERIFICADO"): string {
  const passos: Omit<EventoAncora, "banco" | "execucaoId" | "instanciaId">[] = [
    { evento: "POSSE", archive: { caminho: "C:\\b\\x.archive.gz", sha256: SHA_A }, manifesto: { caminho: "C:\\b\\x.manifest.json", sha256: SHA_M } },
    { evento: "INTENCAO", de: "PREPARANDO", para: "RESTAURANDO" },
    { evento: "CONFIRMACAO", de: "PREPARANDO", para: "RESTAURANDO" },
    { evento: "INTENCAO", de: "RESTAURANDO", para: "VALIDANDO" },
    { evento: "CONFIRMACAO", de: "RESTAURANDO", para: "VALIDANDO" },
    { evento: "EVIDENCIAS", evidencias: ev },
    { evento: "INTENCAO", de: "VALIDANDO", para: "VERIFICADO" },
    { evento: "CONFIRMACAO", de: "VALIDANDO", para: "VERIFICADO" },
  ];
  if (final === "LIBERACAO_AUTORIZADA") passos.push({ evento: "INTENCAO", de: "VERIFICADO", para: "LIBERACAO_AUTORIZADA" }, { evento: "CONFIRMACAO", de: "VERIFICADO", para: "LIBERACAO_AUTORIZADA" });
  let t = "";
  for (const p of passos) t += `${proximaLinha(t, { ...base, ...p } as EventoAncora)}\n`;
  return t;
}

const fatos = (estado: EstadoDestino, mud: Partial<FatosAtuais> = {}, posseMud: Partial<NonNullable<FatosAtuais["posse"]>> = {}): FatosAtuais => ({
  banco: base.banco,
  instanciaId: "i1",
  posse: { execucaoId: "e1", estado, banco: base.banco, instanciaId: "i1", archiveSha256: SHA_A, manifestoSha256: SHA_M, archive: "C:\\b\\x.archive.gz", manifesto: "C:\\b\\x.manifest.json", evidencias: ev, ...posseMud },
  archiveInformado: { caminho: "C:\\b\\x.archive.gz", sha256: SHA_A },
  manifestoInformado: { caminho: "C:\\b\\x.manifest.json", sha256: SHA_M },
  shaDoArquivoSha256: SHA_A,
  shaDoManifesto: SHA_A,
  ...mud,
});

const destinoOk: Verificacao[] = [
  { id: "destino.colecoes_exatas", ok: true, detalhe: "" },
  { id: "destino.protegido", ok: true, detalhe: "" },
  { id: "integridade.conteudo", ok: true, detalhe: "" },
  { id: "destino.indices_exatos", ok: true, detalhe: "" },
  { id: "destino.opcoes_colecao", ok: true, detalhe: "" },
  { id: "evidencias.iguais_ao_verificado", ok: true, detalhe: "" },
];
const destinoAdulterado = destinoOk.map((v) => (v.id === "integridade.conteudo" ? { ...v, ok: false } : v));

/** Simula o reverificar real: âncora primeiro; se reprovar, o destino não é examinado. */
function verificacoesDe(texto: string | null, f: FatosAtuais, destino: Verificacao[] = destinoOk): Verificacao[] {
  const anc = conferirAncora(texto, f);
  return anc.some((x) => !x.ok) ? anc : [...anc, ...destino];
}

/** Armazenamento FALSO: estado da posse + registro de toda escrita (intervenção, operação). */
function armazem(estadoInicial: EstadoDestino, alvo: EstadoDestino, cenario: { verificacoes?: Verificacao[]; erroReverificar?: Error; erroIntervir?: Error; intervirRecusa?: boolean; erroTrava?: Error }) {
  const s = { estado: estadoInicial as EstadoDestino, escritas: [] as string[] };
  const portas: PortasReverificacao = {
    reverificar: async () => {
      if (cenario.erroReverificar) throw cenario.erroReverificar;
      return { estado: s.estado, verificacoes: cenario.verificacoes ?? [] };
    },
    intervir: async (motivo) => {
      if (cenario.erroIntervir) throw cenario.erroIntervir;
      if (cenario.intervirRecusa) return { ok: false, detalhe: "a posse mudou durante a transição" };
      s.escritas.push(`intervir:${motivo}`);
      s.estado = "INTERVENCAO_NECESSARIA";
      return { ok: true };
    },
    executar: async () => {
      s.escritas.push(`executar:${alvo}`);
      s.estado = alvo;
      return { ok: true, estado: alvo, detalhe: `→ ${alvo}` };
    },
    exigirTrava: () => {
      if (cenario.erroTrava) throw cenario.erroTrava;
    },
  };
  return { s, portas };
}

describe("X1 — mapa de categorias", () => {
  it("toda verificação produzida por conferirAncora tem categoria explícita", () => {
    const todas = [
      ...conferirAncora(registro(), fatos("VERIFICADO")),
      ...conferirAncora(null, fatos("VERIFICADO")),
      ...conferirAncora("{}\n", fatos("VERIFICADO")),
    ].map((v) => v.id);
    for (const id of new Set(todas)) expect(CATEGORIA_POR_VERIFICACAO[id]).toBeDefined();
    for (const id of destinoOk.map((v) => v.id)) expect(CATEGORIA_POR_VERIFICACAO[id]?.categoria).toBe("DESTINO_ADULTERADO");
  });
  it("posse com ESTADO não admitido pelo registro ⇒ EVIDENCIA_INCONSISTENTE/registro_posse (registra intervenção)", () => {
    const c = classificarFalhas(verificacoesDe(registro("VERIFICADO"), fatos("LIBERACAO_AUTORIZADA")))!;
    expect([c.categoria, c.escopo, c.registrarIntervencao, c.ids]).toEqual(["EVIDENCIA_INCONSISTENTE", "registro_posse", true, ["ancora.estado"]]);
  });
  it("nenhuma falha ⇒ null", () => expect(classificarFalhas(verificacoesDe(registro(), fatos("VERIFICADO")))).toBeNull());
  it("exceção ⇒ FALHA_OPERACIONAL, nunca registra intervenção", () => {
    const c = classificarExcecao(new Error("connection refused"));
    expect(c.categoria).toBe("FALHA_OPERACIONAL");
    expect(c.registrarIntervencao).toBe(false);
  });
  it("id desconhecido ⇒ EVIDENCIA_INCONSISTENTE/desconhecido, sem registro, intervenção manual (falha fechada)", () => {
    const c = classificarFalhas([{ id: "algo.novo", ok: false, detalhe: "" }])!;
    expect([c.categoria, c.escopo, c.registrarIntervencao, c.intervencaoManual]).toEqual(["EVIDENCIA_INCONSISTENTE", "desconhecido", false, true]);
  });
});

type Caso = {
  nome: string;
  verificacoes?: Verificacao[];
  erroReverificar?: Error;
  categoria: string | null;
  escopo?: string;
  estadoDepois: "inalterado" | "INTERVENCAO_NECESSARIA" | "alvo";
  manual?: boolean;
};

function matriz(estado: EstadoDestino, alvo: EstadoDestino): Caso[] {
  const t = registro(estado);
  return [
    { nome: "arquivo INEXISTENTE", verificacoes: [{ id: "ancora.arquivos", ok: false, detalhe: "" }], categoria: "ENTRADA_OPERADOR", estadoDepois: "inalterado", manual: false },
    { nome: "CAMINHO incorreto (aponta para outro backup íntegro)", verificacoes: verificacoesDe(t, fatos(estado, { archiveInformado: { caminho: "C:\\c\\y.archive.gz", sha256: OUTRO }, manifestoInformado: { caminho: "C:\\c\\y.manifest.json", sha256: "E".repeat(64) }, shaDoArquivoSha256: OUTRO, shaDoManifesto: OUTRO })), categoria: "ENTRADA_OPERADOR", estadoDepois: "inalterado", manual: false },
    { nome: "ARQUIVO diferente (sidecars do backup certo ao lado)", verificacoes: verificacoesDe(t, fatos(estado, { archiveInformado: { caminho: "C:\\b\\x.archive.gz", sha256: OUTRO } })), categoria: "ENTRADA_OPERADOR", estadoDepois: "inalterado", manual: false },
    { nome: "SHA informado incorreto com registro/posse/.sha256/manifesto concordando", verificacoes: verificacoesDe(t, fatos(estado, { archiveInformado: { caminho: "C:\\b\\x.archive.gz", sha256: OUTRO }, shaDoArquivoSha256: SHA_A, shaDoManifesto: SHA_A })), categoria: "ENTRADA_OPERADOR", estadoDepois: "inalterado", manual: false },
    { nome: "MANIFESTO informado diferente do registrado", verificacoes: verificacoesDe(t, fatos(estado, { manifestoInformado: { caminho: "C:\\b\\x.manifest.json", sha256: OUTRO } })), categoria: "ENTRADA_OPERADOR", estadoDepois: "inalterado", manual: false },
    { nome: "arquivo CORRETO", verificacoes: verificacoesDe(t, fatos(estado)), categoria: null, estadoDepois: "alvo" },
    { nome: "MANIFESTO do backup adulterado (descreve outro archive)", verificacoes: verificacoesDe(t, fatos(estado, { shaDoManifesto: OUTRO })), categoria: "EVIDENCIA_INCONSISTENTE", escopo: "artefatos_backup", estadoDepois: "inalterado", manual: true },
    { nome: ".sha256 do backup adulterado", verificacoes: verificacoesDe(t, fatos(estado, { shaDoArquivoSha256: OUTRO })), categoria: "EVIDENCIA_INCONSISTENTE", escopo: "artefatos_backup", estadoDepois: "inalterado", manual: true },
    { nome: "POSSE adulterada (SHA do archive)", verificacoes: verificacoesDe(t, fatos(estado, {}, { archiveSha256: OUTRO })), categoria: "EVIDENCIA_INCONSISTENTE", escopo: "registro_posse", estadoDepois: "INTERVENCAO_NECESSARIA", manual: true },
    { nome: "POSSE adulterada (evidências)", verificacoes: verificacoesDe(t, fatos(estado, {}, { evidencias: { ...ev, documentos: 99 } })), categoria: "EVIDENCIA_INCONSISTENTE", escopo: "registro_posse", estadoDepois: "INTERVENCAO_NECESSARIA", manual: true },
    { nome: "POSSE adulterada + archive informado errado ⇒ a ENTRADA não esconde a evidência", verificacoes: verificacoesDe(t, fatos(estado, { archiveInformado: { caminho: "x", sha256: OUTRO } }, { archiveSha256: "C".repeat(64) })), categoria: "EVIDENCIA_INCONSISTENTE", escopo: "registro_posse", estadoDepois: "INTERVENCAO_NECESSARIA", manual: true },
    { nome: "CADEIA adulterada", verificacoes: verificacoesDe(t.replace('"seq":2', '"seq":2 '), fatos(estado)), categoria: "EVIDENCIA_INCONSISTENTE", escopo: "registro", estadoDepois: "inalterado", manual: true },
    { nome: "registro AUSENTE", verificacoes: verificacoesDe(null, fatos(estado)), categoria: "EVIDENCIA_INCONSISTENTE", escopo: "registro", estadoDepois: "inalterado", manual: true },
    { nome: "DESTINO adulterado", verificacoes: verificacoesDe(t, fatos(estado), destinoAdulterado), categoria: "DESTINO_ADULTERADO", estadoDepois: "INTERVENCAO_NECESSARIA", manual: true },
    { nome: "FALHA operacional (conexão)", erroReverificar: new Error("connect ECONNREFUSED 127.0.0.1:27118"), categoria: "FALHA_OPERACIONAL", estadoDepois: "inalterado", manual: false },
    { nome: "posse de OUTRA execução", verificacoes: [{ id: "posse.desta_execucao", ok: false, detalhe: "posse pertence a OUTRA execução" }], categoria: "POSSE_INVALIDA", estadoDepois: "inalterado", manual: false },
    { nome: "posse de OUTRO banco", verificacoes: verificacoesDe(t, fatos(estado, {}, { banco: "mariela_restore_20260101_000009" })), categoria: "POSSE_INVALIDA", estadoDepois: "inalterado", manual: true },
    { nome: "posse de OUTRA instância", verificacoes: verificacoesDe(t, fatos(estado, {}, { instanciaId: "i9" })), categoria: "POSSE_INVALIDA", estadoDepois: "inalterado", manual: true },
  ].map((c) => ({ ...c, alvo })) as Caso[];
}

for (const [operacao, estado, alvo] of [
  ["Liberar", "VERIFICADO", "LIBERACAO_AUTORIZADA"],
  ["IniciarUso", "LIBERACAO_AUTORIZADA", "EM_USO"],
] as [string, EstadoDestino, EstadoDestino][]) {
  describe(`X1 — ${operacao}: categoria e estado ANTES/DEPOIS (armazenamento falso)`, () => {
    for (const c of matriz(estado, alvo)) {
      it(`${c.nome} ⇒ ${c.categoria ?? "executa"}; estado ${c.estadoDepois === "inalterado" ? `${estado} (inalterado)` : c.estadoDepois === "alvo" ? alvo : c.estadoDepois}`, async () => {
        const { s, portas } = armazem(estado, alvo, { verificacoes: c.verificacoes, erroReverificar: c.erroReverificar });
        const antes = s.estado;
        const r = await operarComReverificacao(portas, estado);
        expect(antes).toBe(estado);
        expect(r.categoria).toBe(c.categoria as never);
        if (c.escopo) expect(r.classificacao?.escopo).toBe(c.escopo as never);
        if (c.manual !== undefined) expect(r.classificacao?.intervencaoManual).toBe(c.manual);
        const esperado = c.estadoDepois === "inalterado" ? estado : c.estadoDepois === "alvo" ? alvo : "INTERVENCAO_NECESSARIA";
        expect(s.estado).toBe(esperado);
        expect(r.ok).toBe(c.estadoDepois === "alvo");
        if (c.estadoDepois === "inalterado") expect(s.escritas).toEqual([]);
        if (c.estadoDepois === "INTERVENCAO_NECESSARIA") {
          expect(r.intervencaoPersistida).toBe(true);
          expect(s.escritas).toHaveLength(1);
          expect(s.escritas[0]!.startsWith("intervir:")).toBe(true);
        }
        if (c.estadoDepois === "alvo") expect(s.escritas).toEqual([`executar:${alvo}`]);
      });
    }
  });
}

describe("X1 — política de intervenção segura", () => {
  it("intervenção que FALHA ao registrar (âncora/CAS) ⇒ estado inalterado, divergenciaNaoRegistravel, intervenção manual", async () => {
    for (const cen of [{ erroIntervir: new Error("registro local de evidências inválido") }, { intervirRecusa: true }]) {
      const { s, portas } = armazem("VERIFICADO", "LIBERACAO_AUTORIZADA", { verificacoes: verificacoesDe(registro(), fatos("VERIFICADO"), destinoAdulterado), ...cen });
      const r = await operarComReverificacao(portas, "VERIFICADO");
      expect([r.ok, r.estado, s.estado, r.intervencaoPersistida, r.divergenciaNaoRegistravel, r.classificacao?.intervencaoManual]).toEqual([false, "VERIFICADO", "VERIFICADO", false, true, true]);
      expect(r.categoria).toBe("DESTINO_ADULTERADO");
    }
  });
  it("destino adulterado num destino JÁ em INTERVENCAO ⇒ mantém intervenção, nenhuma escrita", async () => {
    const { s, portas } = armazem("INTERVENCAO_NECESSARIA", "LIBERACAO_AUTORIZADA", { verificacoes: destinoAdulterado });
    const r = await operarComReverificacao(portas, "VERIFICADO");
    expect([r.ok, s.estado, s.escritas.length, r.categoria]).toEqual([false, "INTERVENCAO_NECESSARIA", 0, "DESTINO_ADULTERADO"]);
  });
  it("estado incompatível sem falha ⇒ recusa sem escrita (nunca libera fora de VERIFICADO)", async () => {
    for (const e of ["VALIDANDO", "EM_USO", "REMOVENDO", "LIBERACAO_AUTORIZADA"] as EstadoDestino[]) {
      const { s, portas } = armazem(e, "LIBERACAO_AUTORIZADA", { verificacoes: destinoOk });
      const r = await operarComReverificacao(portas, "VERIFICADO");
      expect([r.ok, s.estado, s.escritas.length]).toEqual([false, e, 0]);
    }
  });
  it("trava perdida entre a reverificação e a escrita ⇒ exceção, nada escrito", async () => {
    const { s, portas } = armazem("VERIFICADO", "LIBERACAO_AUTORIZADA", { verificacoes: verificacoesDe(registro(), fatos("VERIFICADO")), erroTrava: new Error("trava não comprovada") });
    await expect(operarComReverificacao(portas, "VERIFICADO")).rejects.toThrow("trava");
    expect([s.estado, s.escritas.length]).toEqual(["VERIFICADO", 0]);
  });
  it("posse inválida tem precedência sobre o estado (posse alheia nunca é tocada, nem para intervenção)", async () => {
    const { s, portas } = armazem("VERIFICADO", "LIBERACAO_AUTORIZADA", { verificacoes: [{ id: "posse.desta_execucao", ok: false, detalhe: "" }, ...destinoAdulterado] });
    const r = await operarComReverificacao(portas, "VERIFICADO");
    expect([r.categoria, s.escritas.length]).toEqual(["POSSE_INVALIDA", 0]);
  });
});
