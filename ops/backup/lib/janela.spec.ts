import { describe, expect, it } from "bun:test";
import type { Document } from "mongodb";
import {
  AssinaturaNaoConfiavelErro,
  avaliarDevido,
  compararAssinaturas,
  lerAssinatura,
  ultimoMarcoDaJanela,
  verificarPeriodoSemEscrita,
  type Assinatura,
  type FonteAssinatura,
} from "./janela.js";

/** Fase 60.4.3.4.21.2 — decisões puras da janela (23:45, 15 min sem escrita, retomada após ligar o computador). */

const local = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m, 0, 0); // novembro/2026, hora LOCAL

describe("horário-alvo e retomada", () => {
  it("o marco é o último 23:45 que já passou", () => {
    expect(ultimoMarcoDaJanela(local(9, 23, 50), 23, 45).getTime()).toBe(local(9, 23, 45).getTime());
    expect(ultimoMarcoDaJanela(local(10, 9, 0), 23, 45).getTime()).toBe(local(9, 23, 45).getTime());
    expect(ultimoMarcoDaJanela(local(9, 23, 45), 23, 45).getTime()).toBe(local(9, 23, 45).getTime());
  });

  it("23:50 sem backup do dia → devido", () => {
    expect(avaliarDevido(local(9, 23, 50), local(8, 23, 46), 23, 45).devido).toBe(true);
  });

  it("já existe diário válido depois do marco → JA_REALIZADO (não repete)", () => {
    const r = avaliarDevido(local(9, 23, 59), local(9, 23, 46), 23, 45);
    expect(r.devido).toBe(false);
    expect(r.motivo).toContain("JA_REALIZADO");
  });

  it("RETOMADA: computador ligado às 09:00 do dia seguinte sem o backup da noite → continua devido (e só coleta se a janela passar)", () => {
    expect(avaliarDevido(local(10, 9, 0), local(8, 23, 50), 23, 45).devido).toBe(true);
  });

  it("antes das 23:45 com o backup da noite anterior feito → não devido", () => {
    expect(avaliarDevido(local(10, 22, 0), local(9, 23, 50), 23, 45).devido).toBe(false);
  });

  it("primeiro backup da história (nenhum anterior) → devido", () => {
    expect(avaliarDevido(local(10, 1, 0), null, 23, 45).devido).toBe(true);
  });
});

describe("período sem escrita (15 min)", () => {
  const agora = new Date("2026-11-09T23:50:00-03:00");
  const ass = (minutosAtras: number | null): Assinatura => ({
    vendas: { estrategia: "timestamp", contagem: 1, maiorTimestamp: minutosAtras === null ? null : new Date(agora.getTime() - minutosAtras * 60_000).toISOString(), hashConteudo: null },
  });

  it("escrita há 14 min → ADIA; há 16 min → OK", () => {
    expect(verificarPeriodoSemEscrita(ass(14), agora, 15).ok).toBe(false);
    expect(verificarPeriodoSemEscrita(ass(16), agora, 15).ok).toBe(true);
  });

  it("exatamente no limite (15 min) → OK; timestamp no FUTURO (relógio adiantado) → ADIA", () => {
    expect(verificarPeriodoSemEscrita(ass(15), agora, 15).ok).toBe(true);
    expect(verificarPeriodoSemEscrita(ass(-5), agora, 15).ok).toBe(false);
  });

  it("coleções sem timestamp não bloqueiam (a mudança delas é pega pelo hash antes/depois)", () => {
    expect(verificarPeriodoSemEscrita(ass(null), agora, 15).ok).toBe(true);
  });

  it("R21-2.1-01: a janela DECLARA que atualizações sem data (estratégia `conteudo`) só são cobertas pela comparação antes/depois", () => {
    const comConteudo: Assinatura = { ...ass(30), uploads_midia: { estrategia: "conteudo", contagem: 1, maiorTimestamp: null, hashConteudo: "AB" } };
    const v = verificarPeriodoSemEscrita(comConteudo, agora, 15);
    expect(v.ok).toBe(true);
    expect(v.detalhe).toContain("uploads_midia");
    expect(v.detalhe).toContain("antes/depois");
  });
});

describe("assinaturas antes/depois", () => {
  const base: Assinatura = {
    vendas: { estrategia: "timestamp", contagem: 2, maiorTimestamp: "2026-11-09T20:00:00.000Z", hashConteudo: null },
    sequencias: { estrategia: "conteudo", contagem: 3, maiorTimestamp: null, hashConteudo: "AB" },
  };

  it("iguais → sem escrita detectada", () => {
    expect(compararAssinaturas(base, structuredClone(base))).toEqual({ iguais: true, divergentes: [] });
  });

  it("contagem, timestamp (update sem mudar contagem) ou hash diferentes → divergência apontada por coleção", () => {
    expect(compararAssinaturas(base, { ...base, vendas: { ...base.vendas!, contagem: 3 } }).divergentes).toEqual(["vendas"]);
    expect(compararAssinaturas(base, { ...base, vendas: { ...base.vendas!, maiorTimestamp: "2026-11-09T21:00:00.000Z" } }).divergentes).toEqual(["vendas"]);
    expect(compararAssinaturas(base, { ...base, sequencias: { ...base.sequencias!, hashConteudo: "CD" } }).divergentes).toEqual(["sequencias"]);
  });
});

// -------------------------------------------------------------------------------------------------------------
// R21-2.1-01 — leitura da assinatura com uma fonte EM MEMÓRIA (sem MongoDB): uploads_midia por conteúdo.
// -------------------------------------------------------------------------------------------------------------

interface OpcoesFonte {
  /** Lança erro de leitura nesta coleção, na operação indicada. */
  falhar?: { colecao: string; em: "count" | "aggregate" | "find" };
  /** Na leitura do conteúdo desta coleção aparece um documento a mais (escrita concorrente). */
  insercaoDuranteLeitura?: string;
}

function fonte(dados: Record<string, Document[]>, opcoes: OpcoesFonte = {}): FonteAssinatura {
  return {
    collection(nome: string) {
      const docs = dados[nome] ?? [];
      const falha = (em: string) => {
        if (opcoes.falhar?.colecao === nome && opcoes.falhar.em === em) throw new Error(`[INJETADO] falha de leitura em ${nome}.${em}`);
      };
      return {
        async countDocuments() {
          falha("count");
          return docs.length;
        },
        aggregate(pipeline: Document[]) {
          return {
            async toArray() {
              falha("aggregate");
              if (!docs.length) return [];
              const grupo = pipeline[0]!["$group"] as Record<string, { $max: string } | null>;
              const r: Document = { _id: null };
              for (const [k, v] of Object.entries(grupo)) {
                if (k === "_id" || !v) continue;
                const campo = v.$max.slice(1);
                const datas = docs.map((d) => d[campo]).filter((x): x is Date => x instanceof Date);
                r[k] = datas.length ? new Date(Math.max(...datas.map((d) => d.getTime()))) : null;
              }
              return [r];
            },
          };
        },
        find() {
          return {
            sort() {
              const ordenados = [...docs].sort((a, b) => String(a["_id"]).localeCompare(String(b["_id"])));
              return {
                async *[Symbol.asyncIterator]() {
                  falha("find");
                  for (const d of ordenados) yield d;
                  if (opcoes.insercaoDuranteLeitura === nome) yield { _id: "zzz-concorrente" };
                },
              };
            },
          };
        },
      };
    },
  };
}

const CRIADO = new Date("2026-11-09T10:00:00.000Z");
const PRODUTO_A = "6a0000000000000000000001";
const PRODUTO_B = "6a0000000000000000000002";
function uploads(alteracao?: (docs: Document[]) => void): Record<string, Document[]> {
  const docs: Document[] = [
    { _id: "upl-1", produtoId: PRODUTO_A, chave: "products/a/1.jpg", estado: "pendente", tokenReserva: null, criadoEm: CRIADO, reservadoEm: null, confirmadoEm: null, removidoEm: null },
    { _id: "upl-2", produtoId: PRODUTO_A, chave: "products/a/2.jpg", estado: "confirmado", tokenReserva: null, criadoEm: CRIADO, reservadoEm: null, confirmadoEm: CRIADO, removidoEm: null },
  ];
  alteracao?.(docs);
  return { uploads_midia: docs };
}
async function assinaturaUploads(dados: Record<string, Document[]>, opcoes?: OpcoesFonte, limite?: number) {
  return (await lerAssinatura(fonte(dados, opcoes), ["uploads_midia"], limite))["uploads_midia"]!;
}

describe("R21-2.1-01 — uploads_midia participa da assinatura por CONTEÚDO", () => {
  it("estratégia `conteudo`: hash sempre presente, mesmo com criadoEm", async () => {
    const a = await assinaturaUploads(uploads());
    expect(a.estrategia).toBe("conteudo");
    expect(a.hashConteudo).toMatch(/^[0-9A-F]{64}$/);
    expect(a.maiorTimestamp).toBe(CRIADO.toISOString());
  });

  it("sem alteração → assinatura IGUAL (determinística, mesmo com objetos recriados)", async () => {
    expect(await assinaturaUploads(uploads())).toEqual(await assinaturaUploads(uploads()));
  });

  it("alteração de campo SEM mudar criadoEm (descartar: só `estado`) → detectada", async () => {
    const antes = await assinaturaUploads(uploads());
    const depois = await assinaturaUploads(uploads((d) => (d[0]!["estado"] = "descartado")));
    expect(depois.maiorTimestamp).toBe(antes.maiorTimestamp); // a data NÃO mudou...
    expect(compararAssinaturas({ uploads_midia: antes }, { uploads_midia: depois }).divergentes).toEqual(["uploads_midia"]); // ...e mesmo assim detecta
  });

  it("reserva (estado + tokenReserva) e cancelamento da reserva (volta a pendente, reservadoEm null) → detectados", async () => {
    const base = await assinaturaUploads(uploads());
    const reservado = await assinaturaUploads(uploads((d) => Object.assign(d[0]!, { estado: "confirmando", tokenReserva: "tok" })));
    expect(reservado.hashConteudo).not.toBe(base.hashConteudo);
    const cancelado = await assinaturaUploads(uploads((d) => Object.assign(d[0]!, { estado: "pendente", tokenReserva: null, reservadoEm: null })));
    expect(cancelado).toEqual(base); // estado final idêntico ao inicial ⇒ assinatura idêntica (correto: conteúdo igual)
  });

  it("alteração de REFERÊNCIA (produtoId) → detectada", async () => {
    const antes = await assinaturaUploads(uploads());
    const depois = await assinaturaUploads(uploads((d) => (d[1]!["produtoId"] = PRODUTO_B)));
    expect(depois.hashConteudo).not.toBe(antes.hashConteudo);
  });

  it("remoção LÓGICA (estado removido + removidoEm) e remoção FÍSICA → detectadas", async () => {
    const antes = await assinaturaUploads(uploads());
    const logica = await assinaturaUploads(uploads((d) => Object.assign(d[1]!, { estado: "removido", removidoEm: new Date("2026-11-09T11:00:00.000Z") })));
    expect(logica.hashConteudo).not.toBe(antes.hashConteudo);
    const fisica = await assinaturaUploads(uploads((d) => d.splice(0, 1)));
    expect(fisica.contagem).toBe(1);
    expect(fisica.hashConteudo).not.toBe(antes.hashConteudo);
  });

  it("acima do limite de documentos → AssinaturaNaoConfiavelErro (nunca um falso 'estável')", async () => {
    await expect(assinaturaUploads(uploads(), {}, 1)).rejects.toThrow(AssinaturaNaoConfiavelErro);
    await expect(assinaturaUploads(uploads(), {}, 1)).rejects.toThrow(/excedem o limite/);
  });

  it("contagem muda durante a leitura (escrita concorrente) → AssinaturaNaoConfiavelErro", async () => {
    await expect(assinaturaUploads(uploads(), { insercaoDuranteLeitura: "uploads_midia" })).rejects.toThrow(/contagem mudou durante a leitura/);
  });

  it("falha de leitura (count, aggregate ou find) PROPAGA — a janela não fica elegível", async () => {
    for (const em of ["count", "aggregate", "find"] as const) {
      await expect(assinaturaUploads(uploads(), { falhar: { colecao: "uploads_midia", em } })).rejects.toThrow("[INJETADO]");
    }
  });

  it("coleção `timestamp` com datas: sem hash (custo); `timestamp` com documento SEM data: cai para hash", async () => {
    const vendas = (await lerAssinatura(fonte({ vendas: [{ _id: "1", atualizadoEm: CRIADO, criadoEm: CRIADO }] }), ["vendas"]))["vendas"]!;
    expect(vendas).toMatchObject({ estrategia: "timestamp", hashConteudo: null, maiorTimestamp: CRIADO.toISOString() });
    const semData = (await lerAssinatura(fonte({ vendas: [{ _id: "1", status: "x" }] }), ["vendas"]))["vendas"]!;
    expect(semData.hashConteudo).toMatch(/^[0-9A-F]{64}$/);
  });

  it("sequencias (sem datas) e coleção vazia `conteudo`: hash determinístico", async () => {
    const s1 = (await lerAssinatura(fonte({ sequencias: [{ _id: "venda", valor: 2 }] }), ["sequencias"]))["sequencias"]!;
    const s2 = (await lerAssinatura(fonte({ sequencias: [{ _id: "venda", valor: 3 }] }), ["sequencias"]))["sequencias"]!;
    expect(s1.hashConteudo).not.toBe(s2.hashConteudo);
    const vazia = (await lerAssinatura(fonte({}), ["uploads_midia"]))["uploads_midia"]!;
    expect(vazia).toMatchObject({ contagem: 0, maiorTimestamp: null });
    expect(vazia.hashConteudo).toMatch(/^[0-9A-F]{64}$/);
  });
});
