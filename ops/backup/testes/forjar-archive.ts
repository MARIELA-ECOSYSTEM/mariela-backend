import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { montarArchiveGzip } from "../lib/teste-archive.util.js";
import { BANCO_ORIGEM, COLECOES_BACKUP } from "../lib/politica.js";

/**
 * Fase 60.4.3.4.21.2 — SOMENTE TESTES. Forja, a partir de um backup VÁLIDO, uma cópia "incompatível" com SHA-256
 * coerente (para provar que o restore recusa pelo CONTEÚDO, não só pelo hash):
 *   versao  → archive sintético das 27 coleções declarando server_version 8.2.1 (destino é 8.0.37)
 *   banco   → archive sintético cujo único banco é "outroDB"
 * Uso: bun --no-env-file ops/backup/testes/forjar-archive.ts <versao|banco> <manifesto-original> <archive-saida> <manifesto-saida>
 */

const [modo, manifestoOriginal, archiveSaida, manifestoSaida] = process.argv.slice(2);
if (!modo || !manifestoOriginal || !archiveSaida || !manifestoSaida) throw new Error("uso inválido");

const gz =
  modo === "versao"
    ? montarArchiveGzip({ versaoServidor: "8.2.1", colecoes: COLECOES_BACKUP.map((c) => ({ db: BANCO_ORIGEM, colecao: c })) })
    : montarArchiveGzip({ colecoes: COLECOES_BACKUP.map((c) => ({ db: "outroDB", colecao: c })) });
writeFileSync(archiveSaida, gz);
const sha = createHash("sha256").update(gz).digest("hex").toUpperCase();
writeFileSync(`${archiveSaida}.sha256`, `${sha}  forjado\n`);
const manifesto = JSON.parse(readFileSync(manifestoOriginal, "utf8"));
manifesto.archive.sha256 = sha;
manifesto.archive.versaoServidor = modo === "versao" ? "8.2.1" : manifesto.archive.versaoServidor;
manifesto.archive.documentosPorColecao = Object.fromEntries(COLECOES_BACKUP.map((c) => [c, 0]));
writeFileSync(manifestoSaida, JSON.stringify(manifesto, null, 2));
console.log(JSON.stringify({ ok: true, modo, sha256: sha }));
