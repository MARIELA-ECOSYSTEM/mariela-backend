import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { ArchiveInvalidoErro, descompactar, lerArchive, normalizarIndice, partesDaVersao, verificarArchiveContraPolitica } from "./archive.js";
import { BANCO_ORIGEM, COLECOES_BACKUP } from "./politica.js";
import { montarArchive, montarArchiveGzip, type ColecaoSintetica } from "./teste-archive.util.js";

/** Fase 60.4.3.4.21.2 — leitura estrutural do archive do mongodump (sem restaurar, sem desserializar dados). */

const conformes = (): ColecaoSintetica[] => COLECOES_BACKUP.map((c) => ({ db: BANCO_ORIGEM, colecao: c, docs: c === "produtos" ? [{ a: 1 }, { a: 2 }] : [] }));

function codigoDoErro(fn: () => unknown): string {
  try {
    fn();
  } catch (erro) {
    if (erro instanceof ArchiveInvalidoErro) return erro.codigo;
    throw erro;
  }
  throw new Error("não lançou");
}

describe("lerArchive", () => {
  it("archive conforme: 27 coleções, contagens, versões e todas com bloco de fim", () => {
    const lido = lerArchive(montarArchive({ colecoes: conformes() }));
    expect(lido.versaoServidor).toBe("8.0.37");
    expect(lido.versaoFerramenta).toBe("100.17.0");
    expect(lido.colecoes).toHaveLength(27);
    expect(lido.documentos[`${BANCO_ORIGEM}.produtos`]).toBe(2);
    expect(lido.documentos[`${BANCO_ORIGEM}.vendas`]).toBe(0);
    expect(lido.comFim).toHaveLength(27);
    expect(verificarArchiveContraPolitica(lido, BANCO_ORIGEM, COLECOES_BACKUP).every((v) => v.ok)).toBe(true);
  });

  it("índices do prelude são normalizados (unique/partial/sparse/ttl)", () => {
    const lido = lerArchive(
      montarArchive({
        colecoes: [
          {
            db: BANCO_ORIGEM,
            colecao: "vendas",
            indices: [
              { v: 2, key: { _id: 1 }, name: "_id_" },
              { v: 2, key: { idempotencyKey: 1 }, name: "idempotencyKey_1", unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
              { v: 2, key: { expiresAt: 1 }, name: "expiresAt_1", expireAfterSeconds: 0 },
            ],
          },
        ],
      }),
    );
    const idx = lido.colecoes[0]!.indices;
    expect(idx.map((i) => i.nome)).toEqual(["_id_", "expiresAt_1", "idempotencyKey_1"]);
    expect(idx.find((i) => i.nome === "idempotencyKey_1")).toMatchObject({ unique: true, parcial: '{"idempotencyKey":{"$type":"string"}}' });
    expect(idx.find((i) => i.nome === "expiresAt_1")?.ttl).toBe(0);
    // o mesmo índice vindo do driver (números JS) normaliza igual
    expect(normalizarIndice({ v: 2, key: { expiresAt: 1 }, name: "expiresAt_1", expireAfterSeconds: 0 })).toEqual(idx.find((i) => i.nome === "expiresAt_1")!);
  });

  it("magic ausente → MAGIC_INVALIDO", () => {
    const b = montarArchive({ colecoes: conformes() });
    b.writeUInt32LE(0x12345678, 0);
    expect(codigoDoErro(() => lerArchive(b))).toBe("MAGIC_INVALIDO");
  });

  it("archive truncado em QUALQUER byte: ou a leitura falha, ou a verificação de política recusa — nunca passa", () => {
    const b = montarArchive({ colecoes: conformes() });
    // Fronteiras de bloco (fim de cada documento/terminador) são onde um corte poderia "terminar limpo": todas, ±1 byte.
    const fronteiras: number[] = [];
    for (let p = 4; p < b.length; ) {
      const v = b.readInt32LE(p);
      p += v === -1 ? 4 : v;
      fronteiras.push(p);
    }
    const cortes = new Set<number>([0, 1, 3, 4, 5]);
    for (const f of fronteiras) for (const d of [-1, 0, 1]) if (f + d >= 0 && f + d < b.length) cortes.add(f + d);
    for (let p = 0; p < b.length; p += 17) cortes.add(p);
    for (const corte of cortes) {
      let recusado: boolean;
      try {
        const lido = lerArchive(b.subarray(0, corte));
        recusado = !verificarArchiveContraPolitica(lido, BANCO_ORIGEM, COLECOES_BACKUP).every((v) => v.ok);
      } catch (erro) {
        recusado = erro instanceof ArchiveInvalidoErro;
      }
      if (!recusado) throw new Error(`corte em ${corte} de ${b.length} bytes passou como válido`);
    }
  });

  it("vazio → MAGIC_INVALIDO", () => {
    expect(codigoDoErro(() => lerArchive(Buffer.alloc(0)))).toBe("MAGIC_INVALIDO");
  });

  it("gzip: não-gzip → GZIP_INVALIDO; gzip truncado → GZIP_INVALIDO", () => {
    expect(codigoDoErro(() => descompactar(Buffer.from("isto não é gzip")))).toBe("GZIP_INVALIDO");
    const gz = montarArchiveGzip({ colecoes: conformes() });
    expect(codigoDoErro(() => descompactar(gz.subarray(0, gz.length - 10)))).toBe("GZIP_INVALIDO");
    expect(descompactar(gzipSync(Buffer.from("ok"))).toString()).toBe("ok");
  });

  it("política: outro banco, coleção a mais (token), coleção a menos e coleção sem fim são todos detectados", () => {
    const outroBanco = lerArchive(montarArchive({ colecoes: conformes().map((c) => ({ ...c, db: "test" })) }));
    expect(verificarArchiveContraPolitica(outroBanco, BANCO_ORIGEM, COLECOES_BACKUP).find((v) => v.id === "archive.banco_unico")?.ok).toBe(false);

    const comToken = lerArchive(montarArchive({ colecoes: [...conformes(), { db: BANCO_ORIGEM, colecao: "refresh_tokens" }] }));
    expect(verificarArchiveContraPolitica(comToken, BANCO_ORIGEM, COLECOES_BACKUP).find((v) => v.id === "archive.colecoes_exatas")?.ok).toBe(false);

    const semVendas = lerArchive(montarArchive({ colecoes: conformes().filter((c) => c.colecao !== "vendas") }));
    expect(verificarArchiveContraPolitica(semVendas, BANCO_ORIGEM, COLECOES_BACKUP).find((v) => v.id === "archive.colecoes_exatas")?.ok).toBe(false);

    const semFim = lerArchive(montarArchive({ colecoes: conformes(), semFimPara: ["caixas"] }));
    expect(verificarArchiveContraPolitica(semFim, BANCO_ORIGEM, COLECOES_BACKUP).find((v) => v.id === "archive.todas_com_fim")?.ok).toBe(false);
  });

  it("partesDaVersao", () => {
    expect(partesDaVersao("8.0.37")).toEqual({ maior: 8, menor: 0, correcao: 37 });
    expect(partesDaVersao(null)).toBeNull();
    expect(partesDaVersao("x")).toBeNull();
  });
});
