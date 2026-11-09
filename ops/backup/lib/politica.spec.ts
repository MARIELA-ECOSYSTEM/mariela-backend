import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { COLECOES_BACKUP, COLECOES_EXCLUIDAS, RETENCAO, SEQUENCIAS_E_CODIGOS } from "./politica.js";

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

  it("toda sequência aponta para uma coleção incluída no backup", () => {
    for (const { colecao } of Object.values(SEQUENCIAS_E_CODIGOS)) expect(COLECOES_BACKUP as readonly string[]).toContain(colecao);
  });
});
