import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ASSINATURA_POR_COLECAO, COLECOES_BACKUP, COLECOES_EXCLUIDAS, RETENCAO, SEQUENCIAS_E_CODIGOS } from "./politica.js";

/** Para cada coleção declarada num schema: o arquivo mantém `atualizadoEm`? tem `criadoEm`? `updatedAt: false`? */
function opcoesTimestampPorColecao(): Record<string, { atualizadoEm: boolean; criadoEm: boolean; updatedFalse: boolean }> {
  const raiz = join(import.meta.dir, "..", "..", "..", "src");
  const r: Record<string, { atualizadoEm: boolean; criadoEm: boolean; updatedFalse: boolean }> = {};
  const visitar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) visitar(caminho);
      else if (nome.endsWith(".schema.ts")) {
        const texto = readFileSync(caminho, "utf8");
        for (const m of texto.matchAll(/collection:\s*"([a-z_]+)"/g)) {
          r[m[1]!] = {
            atualizadoEm: /updatedAt:\s*"atualizadoEm"/.test(texto),
            criadoEm: /createdAt:\s*"criadoEm"/.test(texto) || /criadoEm!?:\s*Date/.test(texto),
            updatedFalse: /updatedAt:\s*false/.test(texto),
          };
        }
      }
    }
  };
  visitar(raiz);
  return r;
}

/**
 * Fase 60.4.3.4.21.2 — a lista positiva do backup não pode divergir do código: TODA coleção declarada num schema
 * (`collection: "..."`) está em exatamente uma das listas (27 incluídas + 2 excluídas). Uma coleção nova no código
 * quebra este teste até a política ser revisada.
 */

function colecoesDosSchemas(): string[] {
  const raiz = join(import.meta.dir, "..", "..", "..", "src");
  const nomes = new Set<string>();
  const visitar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) visitar(caminho);
      else if (nome.endsWith(".schema.ts")) {
        for (const m of readFileSync(caminho, "utf8").matchAll(/collection:\s*"([a-z_]+)"/g)) nomes.add(m[1]!);
      }
    }
  };
  visitar(raiz);
  return [...nomes].sort();
}

describe("política de backup", () => {
  it("27 incluídas + 2 excluídas = exatamente as coleções declaradas nos schemas, sem sobreposição", () => {
    expect(COLECOES_BACKUP).toHaveLength(27);
    expect(COLECOES_EXCLUIDAS).toEqual(["refresh_tokens", "vendedor_refresh_tokens"]);
    expect(COLECOES_BACKUP.filter((c) => (COLECOES_EXCLUIDAS as readonly string[]).includes(c))).toEqual([]);
    const declaradas: string[] = [...COLECOES_BACKUP, ...COLECOES_EXCLUIDAS].sort();
    expect(declaradas).toEqual(colecoesDosSchemas());
  });

  it("retenção aprovada", () => {
    expect(RETENCAO).toEqual({ diarios: 14, semanais: 8, mensais: 12, extraordinarios: 5, invalidosDias: 7, minimoValidos: 2 });
  });

  it("R21-2.1-01: estratégia de assinatura declarada para as 27 e coerente com os schemas reais", () => {
    expect(Object.keys(ASSINATURA_POR_COLECAO).sort()).toEqual([...COLECOES_BACKUP].sort());
    const schemas = opcoesTimestampPorColecao();
    for (const [colecao, regra] of Object.entries(ASSINATURA_POR_COLECAO)) {
      const ts = schemas[colecao];
      expect({ colecao, schemaEncontrado: ts !== undefined }).toEqual({ colecao, schemaEncontrado: true });
      // `timestamp` só se o schema mantém atualizadoEm; `insercao` só se o schema tem criadoEm e updatedAt false.
      if (regra.estrategia === "timestamp") expect({ colecao, atualizado: ts!.atualizadoEm }).toEqual({ colecao, atualizado: true });
      if (regra.estrategia === "insercao") expect({ colecao, criado: ts!.criadoEm, semUpdated: ts!.updatedFalse }).toEqual({ colecao, criado: true, semUpdated: true });
      // Schema sem atualizadoEm nunca pode ser `timestamp` (a atualização ficaria invisível).
      if (!ts!.atualizadoEm) expect({ colecao, estrategia: regra.estrategia }).not.toEqual({ colecao, estrategia: "timestamp" });
    }
    // Regressão do defeito: uploads_midia (atualizada sem mexer em data) é por conteúdo.
    expect(ASSINATURA_POR_COLECAO.uploads_midia.estrategia).toBe("conteudo");
  });

  it("toda sequência aponta para uma coleção incluída no backup", () => {
    for (const { colecao } of Object.values(SEQUENCIAS_E_CODIGOS)) expect(COLECOES_BACKUP as readonly string[]).toContain(colecao);
  });
});
