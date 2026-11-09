import { MongoClient, MongoServerError, type Db } from "mongodb";
import { idsDoArchiveGzipDoArquivo } from "../lib/archive.js";
import { adquirirPosse, COLECAO_POSSE, limparDestinoComPosse } from "../lib/posse.js";
import { BANCO_ORIGEM, COLECOES_BACKUP } from "../lib/politica.js";
import { readFileSync } from "node:fs";

/**
 * Fase 60.4.3.4.21.2.4 — SOMENTE TESTES de concorrência (testes-posse.ps1). Age APENAS na instância isolada
 * 127.0.0.1:27118 e APENAS em bancos `mariela_restore_20260103_*` (criados por estes testes). Simula o "outro" agente:
 * escritas alheias em momentos precisos, adulteração da posse, aquisições concorrentes e limpeza com ganchos.
 *
 *   bun --no-env-file posse-auxiliar.ts <comando> <banco> [args...]   → uma linha JSON
 */

const URI = "mongodb://127.0.0.1:27118/?directConnection=true";
const PADRAO = /^mariela_restore_20260103_\d{6}$/;
const [comando, banco, ...args] = process.argv.slice(2);
if (!comando || !banco || !PADRAO.test(banco)) {
  console.error("uso: <comando> <mariela_restore_20260103_HHMMSS> [args]");
  process.exit(2);
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const colecoesDe = async (db: Db) => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();

async function aguardar(db: Db, gatilho: string, limiteMs: number): Promise<{ ok: boolean; colecoes: string[] }> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    const cs = await colecoesDe(db);
    const doArchive = cs.filter((c) => c !== COLECAO_POSSE);
    // "qualquer": o banco ganhou alguma coleção (usado para reproduzir o defeito no fluxo ANTIGO, que não tinha posse).
    if (gatilho === "qualquer" && cs.length > 0) return { ok: true, colecoes: cs };
    if (gatilho === "posse" && cs.includes(COLECAO_POSSE)) return { ok: true, colecoes: cs };
    if (gatilho === "restaurando" && cs.includes(COLECAO_POSSE) && doArchive.length > 0) return { ok: true, colecoes: cs };
    if (gatilho === "restaurado" && cs.includes(COLECAO_POSSE) && COLECOES_BACKUP.every((c) => cs.includes(c))) return { ok: true, colecoes: cs };
    await dormir(5);
  }
  return { ok: false, colecoes: await colecoesDe(db) };
}

async function inserirAlheio(db: Db, colecao: string, marca: string) {
  try {
    await db.collection(colecao).insertOne({ _id: `ALHEIO-${marca}` as never, alheio: true, marca, em: new Date() });
    return { inserido: true, colecao };
  } catch (e) {
    return { inserido: false, colecao, codigo: e instanceof MongoServerError ? e.code : null, erro: String((e as Error).message).slice(0, 160) };
  }
}

function referencia(arquivo: string, manifesto: string) {
  const todos = idsDoArchiveGzipDoArquivo(arquivo);
  const idsPorColecao = new Map<string, Set<string>>();
  for (const [ns, ids] of todos) if (ns.startsWith(`${BANCO_ORIGEM}.`)) idsPorColecao.set(ns.slice(BANCO_ORIGEM.length + 1), ids);
  const m = JSON.parse(readFileSync(manifesto, "utf8").replace(/^﻿/, ""));
  return { idsPorColecao, indicesPorColecao: m.indices?.porColecao ?? {} };
}

const c = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
await c.connect();
let saida: unknown;
try {
  const db = c.db(banco);
  switch (comando) {
    // Espera o gatilho e grava um documento alheio (o "outro agente" do TOCTOU).
    case "aguardar-e-inserir": {
      const [gatilho, colecao, marca, limite] = args as [string, string, string, string?];
      const g = await aguardar(db, gatilho, Number(limite ?? 60000));
      // colecao "-" = só esperar o gatilho (sem escrita).
      saida = !g.ok
        ? { gatilho, inserido: false, erro: "gatilho não ocorreu", colecoes: g.colecoes }
        : colecao === "-"
          ? { gatilho, viu: g.colecoes.length }
          : { gatilho, viu: g.colecoes.length, ...(await inserirAlheio(db, colecao, marca)) };
      break;
    }
    // Espera o gatilho e adultera a posse (trocar execucaoId / remover o documento).
    case "aguardar-e-adulterar": {
      const [gatilho, modo, limite] = args as [string, string, string?];
      const g = await aguardar(db, gatilho, Number(limite ?? 60000));
      if (!g.ok) { saida = { adulterado: false, erro: "gatilho não ocorreu" }; break; }
      if (modo === "trocar") await db.collection(COLECAO_POSSE).updateOne({ _id: "posse" as never }, { $set: { execucaoId: "00000000-0000-0000-0000-000000000000" } });
      else await db.collection(COLECAO_POSSE).deleteMany({});
      saida = { adulterado: true, modo };
      break;
    }
    case "inserir": {
      const [colecao, marca] = args as [string, string];
      saida = await inserirAlheio(db, colecao, marca);
      break;
    }
    // Aquisição concorrente direta: todos esperam a mesma barreira de relógio e chamam adquirirPosse ao mesmo tempo.
    case "adquirir-na-barreira": {
      const [execucaoId, barreira] = args as [string, string];
      while (Date.now() < Number(barreira)) await dormir(1);
      const r = await adquirirPosse(db, { execucaoId, pid: process.pid, processoInicio: "teste", banco, archive: "-", archiveSha256: "-", manifesto: "-" });
      saida = { execucaoId, ...r };
      break;
    }
    // Limpeza com ganchos: escrita alheia DEPOIS do congelamento e coleção alheia DEPOIS da verificação.
    case "limpar-com-ganchos": {
      const [execucaoId, arquivo, manifesto, modo] = args as [string, string, string, string];
      const eventos: unknown[] = [];
      const r = await limparDestinoComPosse(db, execucaoId, referencia(arquivo, manifesto), {
        aposCongelar: async () => { if (modo === "congelar" || modo === "ambos") eventos.push({ aposCongelar: await inserirAlheio(db, "produtos", "T05-congelado") }); },
        aposVerificar: async () => {
          if (modo === "verificar" || modo === "ambos") {
            eventos.push({ aposVerificarProdutos: await inserirAlheio(db, "produtos", "T05-pos-verificacao") });
            eventos.push({ aposVerificarNova: await inserirAlheio(db, "alheia_t05", "T05-nova") });
          }
        },
      });
      saida = { ...r, eventos };
      break;
    }
    case "estado": {
      const existe = (await c.db("admin").admin().listDatabases({ nameOnly: true })).databases.some((d) => d.name === banco);
      const colecoes = existe ? await colecoesDe(db) : [];
      const alheios: Record<string, number> = {};
      const contagens: Record<string, number> = {};
      for (const n of colecoes) {
        contagens[n] = await db.collection(n).countDocuments({});
        const a = await db.collection(n).countDocuments({ alheio: true });
        if (a) alheios[n] = a;
      }
      const posse = colecoes.includes(COLECAO_POSSE) ? await db.collection(COLECAO_POSSE).find({}).toArray() : [];
      saida = { existe, colecoes, contagens, alheios, posse: posse.map((p) => ({ execucaoId: p["execucaoId"], pid: p["pid"] })) };
      break;
    }
    // Remoção de banco CRIADO POR ESTES TESTES (padrão 20260103 já conferido), para o encerramento.
    case "remover-banco-de-teste": {
      await db.dropDatabase();
      saida = { removido: banco };
      break;
    }
    default:
      throw new Error(`comando desconhecido: ${comando}`);
  }
} finally {
  await c.close();
}
console.log(JSON.stringify(saida));
