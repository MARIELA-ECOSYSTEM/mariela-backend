import { MongoClient, ObjectId } from "mongodb";
import { COLECOES_BACKUP, COLECOES_EXCLUIDAS } from "../lib/politica.js";

/**
 * Fase 60.4.3.4.21.2 — SOMENTE TESTES. Prepara uma ORIGEM SINTÉTICA "marielaDB" numa instância MongoDB LOCAL e
 * descartável em 127.0.0.1:27119 (nunca outra porta/host). Dados fictícios, sem nenhuma pessoa real.
 *
 * Uso: bun --no-env-file ops/backup/testes/origem-sintetica.ts <cenario>
 *   base | escrita-recente | caixa-aberto | colecao-desconhecida | reconciliacao-pendente | outro-banco | contagens
 *   | volume [n]  (Fase 21.2.4: acrescenta n documentos sintéticos a um eventos_*, para alongar o mongorestore)
 *   | tipos       (Fase 21.2.6: documentos com todos os tipos BSON e `_id` de vários tipos em eventos_auth)
 */

const URI = "mongodb://127.0.0.1:27119/?directConnection=true";
const cenario = process.argv[2] ?? "base";
const antigo = new Date(Date.now() - 2 * 3600_000);

async function base(c: MongoClient): Promise<void> {
  const db = c.db("marielaDB");
  await db.dropDatabase();
  const ts = { criadoEm: antigo, atualizadoEm: antigo };
  const produtos = [1, 2, 3].map((n) => ({ _id: new ObjectId(), codProduto: `PROD-${String(n).padStart(4, "0")}`, nome: `Produto sintético ${n}`, variantes: [{ _id: new ObjectId(), codVariante: `PROD-${n}-A`, tamanhos: [] }], ...ts }));
  const caixas = [1, 2].map((n) => ({ _id: new ObjectId(), codigo: `CAIXA-${String(n).padStart(4, "0")}`, status: "fechado", ...ts }));
  const vendas = [1, 2].map((n) => ({
    _id: new ObjectId(),
    codigo: `VENDA-2026-11-09-${String(n).padStart(4, "0")}`,
    numero: String(n).padStart(6, "0"),
    status: "concluida",
    caixaId: caixas[0]!._id.toHexString(),
    itens: [{ _id: new ObjectId(), produtoId: produtos[n - 1]!._id.toHexString(), quantidade: 1 }],
    cancelamentos: [],
    idempotencyKey: `idem-${n}`,
    ...ts,
  }));
  await db.collection("produtos").insertMany(produtos);
  await db.collection("caixas").insertMany(caixas);
  await db.collection("vendas").insertMany(vendas);
  await db.collection("movimentos_caixa").insertMany(vendas.map((v) => ({ caixaId: caixas[0]!._id, vendaId: v._id.toHexString(), tipo: "venda", idempotencyKey: null, ...ts })));
  await db.collection("movimentacoes_estoque").insertMany(vendas.map((v, i) => ({ produtoId: produtos[i]!._id, vendaId: v._id.toHexString(), tipo: "saida", origem: "venda", ...ts })));
  await db.collection("uploads_midia").insertOne({ _id: "upl-1" as unknown as ObjectId, produtoId: produtos[0]!._id, chave: "products/x/1.jpg", estado: "confirmado", ...ts });
  for (const [chave, colecao, prefixo, valor] of [
    ["usuario", "usuarios", "USR", 1],
    ["cliente", "clientes", "CLI", 1],
    ["vendedor", "vendedores", "VEN", 1],
    ["fornecedor", "fornecedores", "FOR", 1],
    ["colecao", "colecoes", "COL", 1],
    ["campanha", "campanhas", "CAM", 1],
  ] as const) {
    await db.collection(colecao).insertOne({ codigo: `${prefixo}-0001`, nome: `Fictício ${prefixo}`, telefoneNormalizado: colecao === "usuarios" ? undefined : `1190000000${valor}`, email: colecao === "usuarios" ? "ficticio@exemplo.invalid" : undefined, ...ts });
    await db.collection("sequencias").insertOne({ _id: chave as unknown as ObjectId, valor });
  }
  await db.collection("sequencias").insertMany([
    { _id: "venda" as unknown as ObjectId, valor: 2 },
    { _id: "produto" as unknown as ObjectId, valor: 3 },
    { _id: "caixa" as unknown as ObjectId, valor: 2 },
  ]);
  await db.collection("adquirentes").insertOne({ nome: "Adquirente fictício", nomeNormalizado: "ADQUIRENTE FICTICIO", excluidoEm: null, ...ts });
  await db.collection("configuracoes").insertOne({ _id: "loja" as unknown as ObjectId, tamanhos: ["P", "M"], cores: ["Azul"] }); // sem timestamps → hash
  for (const ev of COLECOES_BACKUP.filter((n) => n.startsWith("eventos_"))) await db.collection(ev).insertOne({ tipo: "sintetico", criadoEm: antigo });
  for (const tok of COLECOES_EXCLUIDAS) {
    await db.collection(tok).insertOne({ tokenHash: `hash-${tok}`, expiresAt: new Date(Date.now() + 86400_000), criadoEm: antigo });
    await db.collection(tok).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection(tok).createIndex({ tokenHash: 1 }, { unique: true });
  }
  // Índices representativos (únicos, parciais, esparsos) — os mesmos tipos da produção.
  await db.collection("produtos").createIndex({ codProduto: 1 }, { unique: true });
  await db.collection("produtos").createIndex({ "variantes.codVariante": 1 }, { unique: true, sparse: true });
  await db.collection("vendas").createIndex({ codigo: 1 }, { unique: true });
  await db.collection("vendas").createIndex({ numero: 1 }, { unique: true });
  await db.collection("vendas").createIndex({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
  await db.collection("caixas").createIndex({ status: 1 }, { unique: true, partialFilterExpression: { status: "aberto" } });
  await db.collection("clientes").createIndex({ telefoneNormalizado: 1 }, { unique: true, partialFilterExpression: { excluidoEm: null } });
  await db.collection("uploads_midia").createIndex({ chave: 1 }, { unique: true });
  await db.collection("movimentos_caixa").createIndex({ caixaId: 1, dataHora: -1 });
  // Garante as 27 + 2 coleções (mesmo as que ficaram sem documento).
  const existentes = (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name);
  for (const n of [...COLECOES_BACKUP, ...COLECOES_EXCLUIDAS]) if (!existentes.includes(n)) await db.createCollection(n);
}

async function principal(): Promise<void> {
  const c = new MongoClient(URI, { serverSelectionTimeoutMS: 10_000 });
  await c.connect();
  try {
    const db = c.db("marielaDB");
    switch (cenario) {
      case "base":
        await base(c);
        break;
      case "escrita-recente":
        await db.collection("vendas").updateOne({}, { $set: { atualizadoEm: new Date() } });
        break;
      case "caixa-aberto":
        await db.collection("caixas").updateOne({}, { $set: { status: "aberto" } });
        break;
      case "colecao-desconhecida":
        await db.createCollection("colecao_nao_prevista");
        break;
      case "reconciliacao-pendente":
        await db.collection("vendas").updateOne({}, { $set: { cancelamentos: [{ _id: new ObjectId(), itens: [{ itemId: "x", quantidade: 1, restaurado: false, estadoRestauracao: "pendente", proximaTentativaEm: null }] }] } });
        break;
      case "outro-banco":
        await c.db("outroDB").dropDatabase();
        await c.db("outroDB").collection("vendas").insertOne({ sintetico: true });
        break;
      case "volume": {
        // Fase 21.2.4: mais documentos (sintéticos) para que o mongorestore dure o bastante para os testes de concorrência.
        const ev = COLECOES_BACKUP.find((n) => n.startsWith("eventos_"))!;
        const n = Number(process.argv[3] ?? 200_000);
        for (let i = 0; i < n; i += 10_000) {
          await db.collection(ev).insertMany(Array.from({ length: Math.min(10_000, n - i) }, (_, k) => ({ tipo: "volume-sintetico", seq: i + k, carga: "x".repeat(64), criadoEm: antigo })), { ordered: false });
        }
        break;
      }
      case "tipos": {
        // Fase 21.2.6: documentos com TODOS os tipos BSON exigidos pela comparação canônica (e `_id` de vários tipos).
        const { Binary, Decimal128, Double, Int32, Long, Timestamp, UUID } = await import("mongodb");
        const ev = "eventos_auth";
        await db.collection(ev).insertMany([
          {
            _id: new ObjectId(),
            tipoTeste: "completo",
            s: "texto",
            i: new Int32(1),
            l: Long.fromNumber(2),
            d: new Double(1.0),
            dz: new Double(-0),
            dec: Decimal128.fromString("1.10"),
            dt: new Date(1700000000123),
            b: new Binary(Buffer.from([1, 2, 3]), 0),
            u: new UUID("0f8fad5b-d9cb-469f-a165-70867728950e"),
            ts: new Timestamp({ t: 5, i: 7 }),
            emb: { a: [1, { b: null }], c: "z" },
            arr: [1, 2, 3],
            n: null,
            criadoEm: antigo,
          },
          { _id: new ObjectId(), tipoTeste: "simples", v: 1, criadoEm: antigo },
          { _id: "id-texto" as unknown as ObjectId, tipoTeste: "id", criadoEm: antigo },
          { _id: new Int32(7) as unknown as ObjectId, tipoTeste: "id", criadoEm: antigo },
          { _id: new UUID("1b4e28ba-2fa1-11d2-883f-0016d3cca427") as unknown as ObjectId, tipoTeste: "id", criadoEm: antigo },
          { _id: Decimal128.fromString("9.99") as unknown as ObjectId, tipoTeste: "id", criadoEm: antigo },
          { _id: { composto: 1, parte: "a" } as unknown as ObjectId, tipoTeste: "id", criadoEm: antigo },
        ]);
        break;
      }
      case "contagens": {
        const r: Record<string, number> = {};
        for (const n of COLECOES_BACKUP) r[n] = await db.collection(n).countDocuments({});
        console.log(JSON.stringify(r));
        break;
      }
      default:
        throw new Error(`cenário desconhecido: ${cenario}`);
    }
    if (cenario !== "contagens") console.log(JSON.stringify({ ok: true, cenario }));
  } finally {
    await c.close();
  }
}

await principal();
