// Fase 60.4.3.4.14 — prova REAL de que o MongoDB do CI aceita transações multi-documento (pré-requisito da correção F04).
//
// Executado pelo workflow `ci.yml` logo depois de o replica set de 1 nó ficar primário, antes dos testes. Usa só o
// `mongoose` já declarado no projeto (nenhuma dependência nova) e um banco DESCARTÁVEL exclusivo do CI:
// `mariela_ci_prova_transacao` — nunca `mariela_test`, `marielaDB` ou qualquer banco operacional.
//
// Passos (qualquer divergência encerra com código 1 e reprova o workflow):
//   1. valida a URI (variável `MONGODB_URI_PROVA_TRANSACAO`): esquema `mongodb://`, hosts locais, banco exato,
//      `replicaSet=rs0` presente e SEM `directConnection=true` — antes de abrir qualquer conexão;
//   2. confirma a topologia pelo comando `hello`: `setName === "rs0"` e `isWritablePrimary === true`;
//   3. abre uma sessão, inicia uma transação e grava um documento marcado;
//   4. confirma o isolamento: a leitura DENTRO da sessão vê o documento; a leitura FORA dela não vê;
//   5. aborta a transação e confirma que nada foi persistido;
//   6. contraprova: uma segunda transação com commit persiste o documento (prova que a gravação transacional é real);
//   7. encerra as sessões, apaga o banco descartável e fecha a conexão — inclusive quando a prova falha.
// Nenhuma saída contém a URI.
//
// Uso (no CI): bun --no-env-file .github/ci/verificar-transacao-mongo.ts
import { randomUUID } from "node:crypto";
import { createConnection } from "mongoose";

const VARIAVEL = "MONGODB_URI_PROVA_TRANSACAO";
const BANCO = "mariela_ci_prova_transacao";
const COLECAO = "prova_transacao";
const HOSTS_LOCAIS = new Set(["127.0.0.1", "localhost"]);

/** Falha da prova: lançada (nunca `process.exit` direto) para a limpeza em `finally` sempre rodar. */
class FalhaDaProva extends Error {}

function falhar(mensagem: string): never {
  throw new FalhaDaProva(mensagem);
}

function ok(mensagem: string): void {
  console.log(`[PROVA-TRANSACAO] OK: ${mensagem}`);
}

function validarUri(uri: string | undefined): string {
  if (!uri || uri.trim() === "") falhar(`${VARIAVEL} não definida.`);
  const partes = /^mongodb:\/\/([^/?\s@]+)\/([^/?\s]+)\?(\S+)$/.exec(uri);
  if (!partes) falhar(`${VARIAVEL} fora do formato esperado mongodb://<host local>/${BANCO}?replicaSet=rs0 (URI não exibida).`);
  const [, autoridade = "", banco = "", query = ""] = partes;
  const hosts = autoridade.split(",").map((host) => host.split(":")[0] ?? "");
  if (!hosts.every((host) => HOSTS_LOCAIS.has(host))) falhar("a prova só roda contra o MongoDB local do runner.");
  if (banco !== BANCO) falhar(`o banco precisa ser exatamente "${BANCO}".`);
  const parametros = new URLSearchParams(query);
  if (parametros.get("replicaSet") !== "rs0") falhar("a URI precisa de replicaSet=rs0.");
  if (parametros.get("directConnection") === "true") falhar("directConnection=true não é aceito: a prova precisa da topologia de replica set.");
  return uri;
}

async function provar(): Promise<void> {
  const uri = validarUri(process.env[VARIAVEL]);
  const conexao = createConnection(uri, { serverSelectionTimeoutMS: 15_000 });
  try {
    await conexao.asPromise().catch((erro: unknown) => falhar(`conexão: ${erro instanceof Error ? erro.name : "erro desconhecido"}`));
    const db = conexao.db;
    if (conexao.name !== BANCO || db === undefined || db.databaseName !== BANCO) falhar(`conexão fora do banco "${BANCO}".`);

    const hello = await db.admin().command({ hello: 1 });
    if (hello["setName"] !== "rs0") falhar(`setName esperado "rs0"; recebido ${JSON.stringify(hello["setName"] ?? null)}.`);
    if (hello["isWritablePrimary"] !== true) falhar("o nó não está como primário gravável (isWritablePrimary !== true).");
    ok(`topologia: setName=rs0, isWritablePrimary=true, membros=${Array.isArray(hello["hosts"]) ? hello["hosts"].length : "?"}`);

    // A coleção é criada FORA da transação (preparação), para a prova não depender de criação implícita.
    const colecao = db.collection(COLECAO);
    await colecao.insertOne({ preparacao: true });
    await colecao.deleteMany({});
    const cliente = conexao.getClient();

    // Transação ABORTADA.
    const marcaAbortada = randomUUID();
    const sessao = cliente.startSession();
    try {
      sessao.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      await colecao.insertOne({ marca: marcaAbortada, criadoEm: new Date() }, { session: sessao });
      if (!sessao.inTransaction()) falhar("a sessão deveria estar em transação.");
      const dentro = await colecao.countDocuments({ marca: marcaAbortada }, { session: sessao });
      if (dentro !== 1) falhar(`dentro da transação a gravação deveria ser visível (1); visto ${dentro}.`);
      const fora = await colecao.countDocuments({ marca: marcaAbortada });
      if (fora !== 0) falhar(`fora da transação a gravação NÃO deveria ser visível antes do commit (0); visto ${fora}.`);
      ok("isolamento: gravação visível dentro da transação e invisível fora dela");
      await sessao.abortTransaction();
      const depoisDoAbort = await colecao.countDocuments({ marca: marcaAbortada });
      if (depoisDoAbort !== 0) falhar(`depois do abort nada deveria persistir (0); visto ${depoisDoAbort}.`);
      ok("transação abortada: a gravação não foi persistida");
    } finally {
      await sessao.endSession();
    }

    // Contraprova com COMMIT: prova que a gravação transacional é efetiva quando confirmada.
    const marcaConfirmada = randomUUID();
    const sessaoCommit = cliente.startSession();
    try {
      sessaoCommit.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      await colecao.insertOne({ marca: marcaConfirmada, criadoEm: new Date() }, { session: sessaoCommit });
      await sessaoCommit.commitTransaction();
      const depoisDoCommit = await colecao.countDocuments({ marca: marcaConfirmada });
      if (depoisDoCommit !== 1) falhar(`depois do commit a gravação deveria persistir (1); visto ${depoisDoCommit}.`);
      ok("contraprova: transação confirmada persiste a gravação");
    } finally {
      await sessaoCommit.endSession();
    }
  } finally {
    // Limpeza: apaga SÓ o banco descartável (guarda de nome) e fecha a conexão — roda também quando a prova falha.
    if (conexao.readyState === 1 && conexao.name === BANCO && conexao.db?.databaseName === BANCO) {
      await conexao.dropDatabase();
      ok(`banco descartável "${BANCO}" removido`);
    }
    await conexao.close();
  }
}

try {
  await provar();
  ok("prova concluída: o MongoDB do CI aceita transações (abort e commit)");
} catch (erro) {
  const detalhe =
    erro instanceof FalhaDaProva ? erro.message : erro instanceof Error ? `${erro.name}: ${erro.message.replace(/mongodb(?:\+srv)?:\/\/\S+/g, "<uri>")}` : String(erro);
  console.error(`[PROVA-TRANSACAO] FALHA: ${detalhe}`);
  process.exitCode = 1;
}
