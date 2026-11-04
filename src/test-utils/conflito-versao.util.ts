import { spyOn } from "bun:test";
import { liberarTudo, novoPonto } from "./barreira.util.js";

/**
 * Fase 56.3.2 — força conflitos REAIS de versão (`VersionError`) nas
 * tentativas de `salvarComRetentativa` de um repositório, de forma
 * determinística (barreiras, sem `setTimeout`).
 *
 * A operação sob teste é pausada logo depois de cada leitura feita DENTRO de
 * `salvarComRetentativa` (as primeiras `conflitos` tentativas); durante a
 * pausa roda `escritaConcorrente` — uma escrita real que avança o `__v` do
 * documento — e só então a operação é liberada, então o `save()` dela falha.
 *
 * `tentativas` conta apenas as leituras da operação sob teste dentro do
 * retry: leituras prévias do service (fora de `salvarComRetentativa`) e as da
 * escrita concorrente não entram. Os spies só observam/pausam e chamam os
 * métodos originais — nenhuma persistência é simulada. Spies e barreiras são
 * sempre restaurados/liberados em `finally`.
 */
export interface RepositorioComRetentativa {
  encontrarPorIdOuFalhar(id: string): Promise<unknown>;
  salvarComRetentativa(id: string, mutar: (documento: unknown) => void, tentativas?: number): Promise<unknown>;
}

export type ResultadoOperacao = { ok: true } | { ok: false; erro: unknown };

export interface ResultadoConflitos {
  resultado: ResultadoOperacao;
  tentativas: number;
}

export function erroDe(resultado: ResultadoOperacao): unknown {
  return resultado.ok ? null : resultado.erro;
}

async function capturar(promessa: Promise<unknown>): Promise<ResultadoOperacao> {
  try {
    await promessa;
    return { ok: true };
  } catch (erro) {
    return { ok: false, erro };
  }
}

export async function executarComConflitosDeVersao(
  repositorio: RepositorioComRetentativa,
  conflitos: number,
  operacao: () => Promise<unknown>,
  escritaConcorrente: (indice: number) => Promise<unknown>,
): Promise<ResultadoConflitos> {
  const pausas = Array.from({ length: conflitos }, () => novoPonto());
  // Originais chamados com o `this` de quem recebeu a chamada: `repositorio` pode ser uma
  // instância ou o `prototype` da classe (quando o módulo cria mais de uma instância).
  const lerOriginal = repositorio.encontrarPorIdOuFalhar;
  const salvarOriginal = repositorio.salvarComRetentativa;
  let dentroDoRetry = 0;
  let escritaConcorrenteEmAndamento = false;
  let tentativas = 0;

  const espiaoSalvar = spyOn(repositorio, "salvarComRetentativa").mockImplementation(async function (
    this: RepositorioComRetentativa,
    id: string,
    mutar: (documento: unknown) => void,
    limite?: number,
  ) {
    dentroDoRetry += 1;
    try {
      return await salvarOriginal.call(this, id, mutar, limite);
    } finally {
      dentroDoRetry -= 1;
    }
  });
  const espiaoLer = spyOn(repositorio, "encontrarPorIdOuFalhar").mockImplementation(async function (this: RepositorioComRetentativa, id: string) {
    const documento = await lerOriginal.call(this, id);
    if (escritaConcorrenteEmAndamento || dentroDoRetry === 0) return documento;
    tentativas += 1;
    const pausa = pausas[tentativas - 1];
    if (pausa) {
      pausa.chegou.liberar(); // leu e está parada antes do save()
      await pausa.liberacao.promessa;
    }
    return documento;
  });

  try {
    const resultado = capturar(operacao());
    const terminou = resultado.then(() => "terminou" as const);
    for (const [indice, pausa] of pausas.entries()) {
      // Se a operação terminar antes de chegar à pausa, não espera para sempre: as asserções mostram o motivo.
      if ((await Promise.race([pausa.chegou.promessa.then(() => "pausou" as const), terminou])) === "terminou") break;
      escritaConcorrenteEmAndamento = true;
      try {
        await escritaConcorrente(indice); // o __v avança: o save() pendente vai falhar
      } finally {
        escritaConcorrenteEmAndamento = false;
      }
      pausa.liberacao.liberar();
    }
    return { resultado: await resultado, tentativas };
  } finally {
    liberarTudo(...pausas);
    espiaoLer.mockRestore();
    espiaoSalvar.mockRestore();
  }
}
