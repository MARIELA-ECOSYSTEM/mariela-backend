/**
 * Fase 22.8.9.10.7.7 — MongoDB DESCARTÁVEL da homologação: inicia a replica set de 1 nó ou desliga o processo.
 * Fala SÓ com 127.0.0.1 na porta de homologação (nunca com outra instância).
 *
 *   bun --no-env-file ops/homologacao-whatsapp/mongo-homologacao.ts iniciar
 *   bun --no-env-file ops/homologacao-whatsapp/mongo-homologacao.ts desligar
 */
import { MongoClient } from "mongodb";
import { PORTA_MONGO_HOMOLOGACAO } from "./verificar-isolamento.js";

export const REPLICA_SET_HOMOLOGACAO = "rs-homologacao-whatsapp";
const URI = `mongodb://127.0.0.1:${PORTA_MONGO_HOMOLOGACAO}/?directConnection=true`;
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function conectar(tentativas: number): Promise<MongoClient> {
  for (let i = 0; ; i++) {
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 1_000 });
    try {
      await c.connect();
      return c;
    } catch (e) {
      await c.close().catch(() => {});
      if (i >= tentativas) throw e;
      await espera(1_000);
    }
  }
}

const comando = process.argv[2];
if (comando === "iniciar") {
  const c = await conectar(60);
  const admin = c.db("admin");
  try {
    await admin.command({ replSetInitiate: { _id: REPLICA_SET_HOMOLOGACAO, members: [{ _id: 0, host: `127.0.0.1:${PORTA_MONGO_HOMOLOGACAO}` }] } });
    console.log("replica set iniciada");
  } catch (e) {
    if (!/already initialized/i.test((e as Error).message)) throw e;
    console.log("replica set já iniciada");
  }
  for (let i = 0; i < 60; i++) {
    const h = await admin.command({ hello: 1 });
    if (h["isWritablePrimary"]) {
      if (h["setName"] !== REPLICA_SET_HOMOLOGACAO) throw new Error("replica set inesperada nesta porta — não é a instância de homologação");
      console.log(`MongoDB de homologação pronto (porta ${PORTA_MONGO_HOMOLOGACAO})`);
      break;
    }
    await espera(1_000);
  }
  await c.close();
} else if (comando === "desligar") {
  let c: MongoClient;
  try {
    c = await conectar(0);
  } catch {
    console.log("MongoDB de homologação já estava parado");
    process.exit(0);
  }
  const h = await c.db("admin").command({ hello: 1 });
  if (h["setName"] !== REPLICA_SET_HOMOLOGACAO) {
    await c.close();
    throw new Error("a instância nesta porta não é a de homologação — nada foi desligado");
  }
  await c.db("admin").command({ shutdown: 1 }).catch(() => {}); // a conexão cai durante o desligamento
  console.log("MongoDB de homologação desligado");
  // O driver tentaria reconectar ao servidor que acabou de desligar e o processo não terminaria.
  await c.close(true).catch(() => {});
  process.exit(0);
} else {
  console.error("uso: mongo-homologacao.ts iniciar|desligar");
  process.exitCode = 2;
}
