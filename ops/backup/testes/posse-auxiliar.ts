import { readFileSync, writeFileSync } from "node:fs";
import { Binary, BSON, Decimal128, Int32, Long, MongoClient, MongoServerError, Timestamp, type Db, type Document } from "mongodb";
import { conteudoDoArchiveGzipDoArquivo } from "../lib/archive.js";
import { conteudoPorColecao } from "../lib/integridade.js";
import { adquirirPosse, COLECAO_POSSE, estaCongelada, infoColecoes, limparDestinoComPosse } from "../lib/posse.js";
import { COLECOES_BACKUP, ESTADOS_INTERROMPIVEIS, type EstadoDestino } from "../lib/politica.js";

/**
 * Fases 60.4.3.4.21.2.4/21.2.6 — SOMENTE TESTES (testes-posse.ps1, testes-seguranca.ps1). Age APENAS na instância
 * isolada 127.0.0.1:27118 e APENAS em bancos `mariela_restore_20260103_*` / `mariela_restore_20260104_*` (criados por
 * estes testes). Simula o "outro" agente: escritas alheias em momentos precisos, adulteração da posse, aquisições
 * concorrentes, limpeza com ganchos, a matriz de privilégios e modificações de conteúdo (com reversão exata).
 *
 *   bun --no-env-file posse-auxiliar.ts <comando> <banco> [args...]   (stdin: {"conexao":{usuario,senha}} ou vazio)
 *   → uma linha JSON. A credencial (sintética) chega SÓ pelo stdin; nunca é impressa.
 */

const URI = "mongodb://127.0.0.1:27118/?directConnection=true";
const PADRAO = /^mariela_restore_2026010[34]_\d{6}$/;
const [comando, banco, ...args] = process.argv.slice(2);
if (!comando || !banco || !PADRAO.test(banco)) {
  console.error("uso: <comando> <mariela_restore_20260103_HHMMSS|mariela_restore_20260104_HHMMSS> [args]");
  process.exit(2);
}

const entrada = (await Bun.stdin.text()).trim();
const conexao = entrada ? (JSON.parse(entrada) as { conexao?: { usuario: string; senha: string } }).conexao : undefined;
const opcoesCliente = conexao ? { auth: { username: conexao.usuario, password: conexao.senha }, authSource: "admin", serverSelectionTimeoutMS: 5000 } : { serverSelectionTimeoutMS: 5000 };

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const colecoesDe = async (db: Db) => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();
const erroDe = (e: unknown) => ({ codigo: e instanceof MongoServerError ? e.code : null, nome: e instanceof MongoServerError ? e.codeName : (e as Error).name });

async function estadoPosse(db: Db): Promise<string | null> {
  try {
    const d = await db.collection(COLECAO_POSSE).findOne({ _id: "posse" as never });
    return (d?.["estado"] as string) ?? null;
  } catch {
    return null;
  }
}

async function aguardar(db: Db, gatilho: string, limiteMs: number): Promise<{ ok: boolean; colecoes: string[]; estado: string | null }> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    const cs = await colecoesDe(db);
    const doArchive = cs.filter((c) => c !== COLECAO_POSSE);
    const estado = cs.includes(COLECAO_POSSE) ? await estadoPosse(db) : null;
    if (gatilho === "qualquer" && cs.length > 0) return { ok: true, colecoes: cs, estado };
    if (gatilho === "posse" && cs.includes(COLECAO_POSSE)) return { ok: true, colecoes: cs, estado };
    if (gatilho === "restaurando" && cs.includes(COLECAO_POSSE) && doArchive.length > 0) return { ok: true, colecoes: cs, estado };
    if (gatilho.startsWith("estado:") && estado === gatilho.slice(7)) return { ok: true, colecoes: cs, estado };
    await dormir(3);
  }
  return { ok: false, colecoes: await colecoesDe(db), estado: null };
}

async function inserirAlheio(db: Db, colecao: string, marca: string, bypass = false) {
  try {
    await db.collection(colecao).insertOne({ _id: `ALHEIO-${marca}` as never, alheio: true, marca, em: new Date() }, bypass ? { bypassDocumentValidation: true } : {});
    return { inserido: true, colecao, bypass };
  } catch (e) {
    return { inserido: false, colecao, bypass, ...erroDe(e) };
  }
}

function referencia(arquivo: string, manifesto: string) {
  const m = JSON.parse(readFileSync(manifesto, "utf8").replace(/^﻿/, ""));
  return { conteudoPorColecao: conteudoPorColecao(conteudoDoArchiveGzipDoArquivo(arquivo)), indicesPorColecao: m.indices?.porColecao ?? {} };
}

const BRUTO = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true } as const;

const c = new MongoClient(URI, opcoesCliente);
await c.connect();
let saida: unknown;
try {
  const db = c.db(banco);
  switch (comando) {
    // Espera o gatilho e grava um documento alheio (o "outro agente"). colecao "-" = só esperar.
    case "aguardar-e-inserir": {
      const [gatilho, colecao, marca, limite, modo] = args as [string, string, string, string?, string?];
      const g = await aguardar(db, gatilho, Number(limite ?? 60000));
      saida = !g.ok
        ? { gatilho, inserido: false, erro: "gatilho não ocorreu", colecoes: g.colecoes }
        : colecao === "-"
          ? { gatilho, viu: g.colecoes.length, estadoVisto: g.estado }
          : { gatilho, viu: g.colecoes.length, estadoVisto: g.estado, em: new Date().toISOString(), ...(await inserirAlheio(db, colecao, marca, modo === "bypass")) };
      break;
    }
    case "aguardar-e-adulterar": {
      const [gatilho, modo, limite] = args as [string, string, string?];
      const g = await aguardar(db, gatilho, Number(limite ?? 60000));
      if (!g.ok) { saida = { adulterado: false, erro: "gatilho não ocorreu" }; break; }
      try {
        if (modo === "trocar") await db.collection(COLECAO_POSSE).updateOne({ _id: "posse" as never }, { $set: { execucaoId: "00000000-0000-0000-0000-000000000000" } });
        else await db.collection(COLECAO_POSSE).deleteMany({});
        saida = { adulterado: true, modo, estadoVisto: g.estado };
      } catch (e) {
        saida = { adulterado: false, modo, ...erroDe(e) };
      }
      break;
    }
    case "inserir": {
      const [colecao, marca, modo] = args as [string, string, string?];
      saida = await inserirAlheio(db, colecao, marca, modo === "bypass");
      break;
    }
    // Matriz de privilégios: tenta UMA operação e devolve se foi aceita.
    case "tentar": {
      const [op, colecao = "produtos"] = args as [string, string?];
      const ops: Record<string, () => Promise<unknown>> = {
        find: () => db.collection(colecao).findOne({}),
        insert: () => db.collection(colecao).insertOne({ _id: `TENTATIVA-${Date.now()}` as never, alheio: true }),
        insertBypass: () => db.collection(colecao).insertOne({ _id: `TENTATIVA-B-${Date.now()}` as never, alheio: true }, { bypassDocumentValidation: true }),
        update: () => db.collection(colecao).updateOne({}, { $set: { alterado: true } }),
        delete: () => db.collection(colecao).deleteOne({ _id: "inexistente" as never }),
        collMod: () => db.command({ collMod: colecao, validator: {} }),
        drop: () => db.command({ drop: `inexistente_${Date.now()}` }),
        dropReal: () => db.command({ drop: colecao }),
        rename: () => c.db("admin").command({ renameCollection: `${banco}.${colecao}`, to: `${banco}.${colecao}_renomeada` }),
        dropDatabase: () => c.db("mariela_restore_20260104_999999").dropDatabase(),
        posseUpdate: () => db.collection(COLECAO_POSSE).updateOne({ _id: "posse" as never }, { $set: { estado: "LIBERACAO_AUTORIZADA" } }),
        posseRemove: () => db.collection(COLECAO_POSSE).deleteOne({ _id: "posse" as never }),
        controleDrop: () => db.command({ drop: COLECAO_POSSE }),
        createIndex: () => db.collection(colecao).createIndex({ campoTentativa: 1 }, { name: "idx_tentativa" }),
        shutdown: () => Promise.reject(Object.assign(new Error("não executado"), { name: "NaoExecutado" })),
      };
      const fn = ops[op];
      if (!fn) throw new Error(`operação desconhecida: ${op}`);
      try {
        await fn();
        saida = { op, aceita: true };
      } catch (e) {
        saida = { op, aceita: false, ...erroDe(e) };
      }
      break;
    }
    // Aquisição concorrente direta: todos esperam a mesma barreira de relógio e chamam adquirirPosse ao mesmo tempo.
    case "adquirir-na-barreira": {
      const [execucaoId, barreira] = args as [string, string];
      while (Date.now() < Number(barreira)) await dormir(1);
      const r = await adquirirPosse(db, { execucaoId, pid: process.pid, processoInicio: "teste", processoInicioTicks: "0", executavel: "teste", banco, archive: "-", archiveSha256: "-", manifesto: "-", manifestoSha256: "-" });
      saida = { execucaoId, ...r };
      break;
    }
    // Marca a posse direta (testes de limpeza): só para destinos montados à mão pelos testes.
    case "forcar-estado": {
      const [estado] = args as [EstadoDestino];
      await db.collection(COLECAO_POSSE).updateOne({ _id: "posse" as never }, { $set: { estado } });
      saida = { estado };
      break;
    }
    // Limpeza com ganchos: escrita alheia DEPOIS do congelamento, DEPOIS da verificação e entre as remoções.
    case "limpar-com-ganchos": {
      const [execucaoId, arquivo, manifesto, modo] = args as [string, string, string, string];
      const eventos: unknown[] = [];
      let primeira = true;
      const r = await limparDestinoComPosse(db, execucaoId, referencia(arquivo, manifesto), ESTADOS_INTERROMPIVEIS, {
        aposCongelar: async () => { if (modo === "congelar" || modo === "ambos") eventos.push({ aposCongelar: await inserirAlheio(db, "produtos", "T05-congelado") }); },
        aposVerificar: async () => {
          if (modo === "verificar" || modo === "ambos") {
            eventos.push({ aposVerificarProdutos: await inserirAlheio(db, "produtos", "T05-pos-verificacao") });
            eventos.push({ aposVerificarNova: await inserirAlheio(db, "alheia_t05", "T05-nova") });
          }
        },
        antesDeRemover: async (col) => {
          // "trocar": na PRIMEIRA remoção, alguém apaga a coleção e a RECRIA com dado alheio (mesmo nome, outro UUID).
          if (modo === "trocar" && primeira) {
            primeira = false;
            await db.command({ drop: col });
            await db.collection(col).insertOne({ _id: "ALHEIO-T05-trocada" as never, alheio: true });
            await db.command({ collMod: col, validator: { $expr: { $eq: [1, 0] } } });
            eventos.push({ trocada: col });
          }
        },
      });
      saida = { ...r, eventos };
      break;
    }
    // Integridade: aplica UMA modificação (como root, com bypass) e guarda o original para reverter exatamente.
    case "modificar": {
      const [caso, arquivoEstado] = args as [string, string];
      const ev = "eventos_auth";
      const docs = await db.collection(ev).find({ tipoTeste: { $exists: true } }, BRUTO).toArray();
      const porTipo = (t: string) => docs.find((d) => (d["tipoTeste"] as string) === t)!;
      const salvar = (col: string, original: Document | null, novoId?: unknown) =>
        writeFileSync(arquivoEstado, JSON.stringify({ col, original: original ? Buffer.from(BSON.serialize(original)).toString("base64") : null, novoId: novoId === undefined ? null : Buffer.from(BSON.serialize({ v: novoId })).toString("base64") }));
      const bp = { bypassDocumentValidation: true };
      const alvo = porTipo("completo");
      switch (caso) {
        case "update-campo": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { s: "alterado" } }, bp); break;
        case "campo-extra": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { extra: 1 } }, bp); break;
        case "campo-removido": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $unset: { s: "" } }, bp); break;
        case "tipo-int32-para-int64": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { i: Long.fromNumber(1) } }, bp); break;
        case "tipo-double-para-int32": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { d: new Int32(1) } }, bp); break;
        case "binario": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { b: new Binary(Buffer.from([1, 2, 4]), 0) } }, bp); break;
        case "binario-subtipo": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { b: new Binary(Buffer.from([1, 2, 3]), 128) } }, bp); break;
        case "decimal": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { dec: Decimal128.fromString("1.1") } }, bp); break;
        case "data": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { dt: new Date(1700000000124) } }, bp); break;
        case "timestamp": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { ts: new Timestamp({ t: 5, i: 8 }) } }, bp); break;
        case "uuid": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { u: new BSON.UUID() } }, bp); break;
        case "embutido": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { "emb.c": "y" } }, bp); break;
        case "array-ordem": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $set: { arr: [3, 2, 1] } }, bp); break;
        case "null-para-ausente": salvar(ev, alvo); await db.collection(ev).updateOne({ _id: alvo["_id"] }, { $unset: { n: "" } }, bp); break;
        case "delete-insert": {
          const o = porTipo("simples");
          salvar(ev, o, o["_id"]);
          await db.collection(ev).deleteOne({ _id: o["_id"] });
          await db.collection(ev).insertOne({ ...o, marca: "reinserido" }, bp);
          break;
        }
        case "mesmo-id-outro-conteudo": {
          const o = porTipo("simples");
          salvar(ev, o, o["_id"]);
          await db.collection(ev).replaceOne({ _id: o["_id"] }, { alheio: true, tipoTeste: "simples" }, bp);
          break;
        }
        case "documento-adicional": salvar(ev, null, "ALHEIO-ADICIONAL"); await db.collection(ev).insertOne({ _id: "ALHEIO-ADICIONAL" as never, alheio: true }, bp); break;
        case "delete-compensado": {
          // remove um documento do archive e insere um alheio: contagem igual
          const o = porTipo("simples");
          salvar(ev, o, "ALHEIO-COMPENSADO");
          await db.collection(ev).deleteOne({ _id: o["_id"] });
          await db.collection(ev).insertOne({ _id: "ALHEIO-COMPENSADO" as never, alheio: true, tipoTeste: "x" }, bp);
          break;
        }
        case "indice-extra": writeFileSync(arquivoEstado, JSON.stringify({ indice: "idx_alheio" })); await db.collection(ev).createIndex({ alheio: 1 }, { name: "idx_alheio" }); break;
        case "sequencia": {
          const s = await db.collection("sequencias").findOne({ _id: "venda" as never }, BRUTO);
          salvar("sequencias", s);
          await db.collection("sequencias").updateOne({ _id: "venda" as never }, { $inc: { valor: 1 } }, bp);
          break;
        }
        default:
          throw new Error(`caso desconhecido: ${caso}`);
      }
      saida = { modificado: caso };
      break;
    }
    case "reverter": {
      const [arquivoEstado] = args as [string];
      const e = JSON.parse(readFileSync(arquivoEstado, "utf8")) as { col?: string; original?: string | null; novoId?: string | null; indice?: string };
      if (e.indice) {
        await db.collection("eventos_auth").dropIndex(e.indice);
      } else {
        const col = db.collection(e.col!);
        if (e.novoId) await col.deleteOne({ _id: BSON.deserialize(Buffer.from(e.novoId, "base64"), BRUTO)["v"] }, {});
        if (e.original) {
          const original = BSON.deserialize(Buffer.from(e.original, "base64"), BRUTO);
          await col.deleteOne({ _id: original["_id"] });
          await col.insertOne(original, { bypassDocumentValidation: true });
        }
      }
      saida = { revertido: true };
      break;
    }
    case "estado": {
      const existe = (await c.db("admin").admin().listDatabases({ nameOnly: true })).databases.some((d) => d.name === banco);
      const info = existe ? await infoColecoes(db) : [];
      const colecoes = info.map((x) => x.nome).sort();
      const alheios: Record<string, number> = {};
      const contagens: Record<string, number> = {};
      for (const n of colecoes) {
        contagens[n] = await db.collection(n).countDocuments({});
        const a = await db.collection(n).countDocuments({ alheio: true });
        if (a) alheios[n] = a;
      }
      const posse = colecoes.includes(COLECAO_POSSE) ? await db.collection(COLECAO_POSSE).find({}).toArray() : [];
      const congeladas = info.filter((x) => x.nome !== COLECAO_POSSE && estaCongelada(x)).length;
      const dados = info.filter((x) => COLECOES_BACKUP.includes(x.nome as never)).length;
      saida = { existe, colecoes, contagens, alheios, congeladas, dados, posse: posse.map((p) => ({ execucaoId: p["execucaoId"], estado: p["estado"], pid: p["pid"] })) };
      break;
    }
    // Remoção de banco CRIADO POR ESTES TESTES (padrão já conferido), para o encerramento. Exige o bootstrap.
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
