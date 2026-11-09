import { gzipSync } from "node:zlib";
import { EJSON, Long, serialize, type Document } from "bson";
import { MAGIC_ARCHIVE } from "./archive.js";

/**
 * Fase 60.4.3.4.21.2 — SÓ PARA TESTES: monta um archive do mongodump no mesmo formato conferido num dump real do
 * Database Tools 100.17.0 (magic, cabeçalho, prelude, terminador, blocos por coleção com EOF). Dados sintéticos.
 */

const TERMINADOR = Buffer.from([0xff, 0xff, 0xff, 0xff]);

export interface ColecaoSintetica {
  db: string;
  colecao: string;
  docs?: Document[];
  indices?: Document[];
  opcoes?: Document;
}

export function montarArchive(opcoes: { colecoes: ColecaoSintetica[]; versaoServidor?: string; semFimPara?: string[] }): Buffer {
  const magic = Buffer.alloc(4);
  magic.writeUInt32LE(MAGIC_ARCHIVE);
  const partes: Buffer[] = [
    magic,
    Buffer.from(serialize({ concurrent_collections: 4, version: "0.1", server_version: opcoes.versaoServidor ?? "8.0.37", tool_version: "100.17.0" })),
  ];
  for (const c of opcoes.colecoes) {
    const metadata = EJSON.stringify(
      { indexes: c.indices ?? [{ v: 2, key: { _id: 1 }, name: "_id_" }], uuid: "00000000000000000000000000000000", collectionName: c.colecao, type: "collection", ...(c.opcoes ? { options: c.opcoes } : {}) },
      { relaxed: false },
    );
    partes.push(Buffer.from(serialize({ db: c.db, collection: c.colecao, metadata, size: 0, type: "collection" })));
  }
  partes.push(TERMINADOR);
  for (const c of opcoes.colecoes) {
    partes.push(Buffer.from(serialize({ db: c.db, collection: c.colecao, EOF: false, CRC: Long.fromNumber(0) })));
    for (const d of c.docs ?? []) partes.push(Buffer.from(serialize(d)));
    partes.push(TERMINADOR);
    if (!(opcoes.semFimPara ?? []).includes(c.colecao)) {
      partes.push(Buffer.from(serialize({ db: c.db, collection: c.colecao, EOF: true, CRC: Long.fromNumber(0) })));
      partes.push(TERMINADOR);
    }
  }
  return Buffer.concat(partes);
}

export function montarArchiveGzip(opcoes: Parameters<typeof montarArchive>[0]): Buffer {
  return gzipSync(montarArchive(opcoes));
}
