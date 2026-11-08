import { Error as MongooseErrors, mongo, type ClientSession, type Connection } from "mongoose";
import { ApiException } from "../common/exceptions/api.exception.js";

/**
 * Fase 60.4.3.4.15 (F04) — executor de transação MongoDB com SESSÃO EXPLÍCITA.
 *
 * Por que não `session.withTransaction()` direto: ele repete o callback por até 120 s sem espera entre as tentativas
 * e não conhece o `VersionError` do Mongoose. Aqui as tentativas são LIMITADAS e espaçadas, e o que é repetido é
 * SEMPRE a transação inteira (nunca uma operação isolada fora dela — o que duplicaria efeitos):
 *   - `TransientTransactionError` (ex.: `WriteConflict` com outra transação, eleição de primário): aborta e repete;
 *   - `VersionError` (concorrência otimista do Mongoose num documento alterado por escrita fora de transação): idem;
 *   - `UnknownTransactionCommitResult` no commit: repete SÓ o commit (idempotente no servidor);
 *   - qualquer outro erro (regra de negócio, E11000, validação): aborta e propaga sem repetir.
 * Esgotadas as tentativas por conflito, responde 409 (CONFLICT) — nunca um 500 com o erro cru do driver.
 *
 * Exige replica set (ou mongos): num MongoDB standalone o servidor recusa a transação e o erro é propagado.
 * A operação recebe a sessão e DEVE repassá-la a todas as leituras e escritas que fazem parte da unidade atômica,
 * e não pode engolir erros do servidor (a transação já estaria abortada no servidor).
 */
export const MAXIMO_TENTATIVAS_TRANSACAO = 8;
const MAXIMO_TENTATIVAS_COMMIT = 3;
const ESPERA_BASE_MS = 25;
const ESPERA_MAXIMA_MS = 200;

export const MENSAGEM_CONFLITO_TRANSACAO =
  "Não foi possível concluir a operação: os mesmos dados foram alterados por outra operação simultânea. Tente novamente.";

function temRotulo(erro: unknown, rotulo: string): boolean {
  return erro instanceof mongo.MongoError && erro.hasErrorLabel(rotulo);
}

/** Erros em que a transação inteira pode ser repetida com segurança (nada foi confirmado). */
export function ehErroTransitorioDeTransacao(erro: unknown): boolean {
  return temRotulo(erro, "TransientTransactionError") || erro instanceof MongooseErrors.VersionError;
}

async function esperar(tentativa: number): Promise<void> {
  const base = Math.min(ESPERA_MAXIMA_MS, ESPERA_BASE_MS * 2 ** (tentativa - 1));
  const atraso = base + Math.floor(Math.random() * ESPERA_BASE_MS);
  await new Promise<void>((resolver) => setTimeout(resolver, atraso));
}

async function confirmar(sessao: ClientSession): Promise<void> {
  for (let tentativa = 1; ; tentativa += 1) {
    try {
      await sessao.commitTransaction();
      return;
    } catch (erro) {
      if (temRotulo(erro, "UnknownTransactionCommitResult") && tentativa < MAXIMO_TENTATIVAS_COMMIT) continue;
      throw erro;
    }
  }
}

export async function executarEmTransacao<T>(conexao: Connection, operacao: (sessao: ClientSession) => Promise<T>): Promise<T> {
  const sessao = await conexao.startSession();
  try {
    for (let tentativa = 1; ; tentativa += 1) {
      sessao.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
      try {
        const resultado = await operacao(sessao);
        await confirmar(sessao);
        return resultado;
      } catch (erro) {
        if (sessao.inTransaction()) {
          // Abortar é só limpeza: se o próprio abort falhar, o servidor descarta a transação ao expirar.
          await sessao.abortTransaction().catch(() => undefined);
        }
        if (!ehErroTransitorioDeTransacao(erro)) throw erro;
        if (tentativa >= MAXIMO_TENTATIVAS_TRANSACAO) throw ApiException.conflict(MENSAGEM_CONFLITO_TRANSACAO);
        await esperar(tentativa);
      }
    }
  } finally {
    await sessao.endSession();
  }
}
