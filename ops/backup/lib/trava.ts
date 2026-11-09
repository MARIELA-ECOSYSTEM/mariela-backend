import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Verificacao } from "./archive.js";
import { raizIsolada } from "./instancia.js";
import { RESTORE } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2.4 (R21-2.3-01) — trava de exclusão mútua LOCAL do restore. Quem ADQUIRE é o PowerShell
 * (`Enter-TravaRestore`, comum.ps1): abre `<raiz>\locks\restore.lock` com FileShare.Read e a mantém aberta durante
 * TODA a execução — outro processo não consegue abri-la para escrita (atomicidade e liberação em queda: o SO).
 * Aqui a CLI só VERIFICA, antes de cada operação de posse/limpeza:
 *   - a trava está SEGURA agora (abrir para escrita falha com EBUSY/EPERM);
 *   - o conteúdo nomeia ESTA execução (`execucaoId`);
 *   - o dono gravado é o processo PAI desta CLI (o restore que a chamou), não um processo qualquer.
 * Garantia LOCAL (mesma máquina). Não há exclusão distribuída.
 */

export interface ConteudoTrava {
  execucaoId?: string;
  pid?: number;
  processoInicio?: string;
  banco?: string;
  livre?: boolean;
}

export function caminhoTrava(raiz?: string): string {
  return join(raizIsolada(raiz), ...RESTORE.arquivoTrava.split("/"));
}

export function lerTrava(caminho: string): ConteudoTrava | null {
  try {
    const texto = readFileSync(caminho, "utf8").replace(/^﻿/, "").trim();
    return texto ? (JSON.parse(texto) as ConteudoTrava) : null;
  } catch {
    return null;
  }
}

/** A trava está SEGURA por algum processo? (abrir para escrita é recusado pelo compartilhamento do SO). */
export function travaSegura(caminho: string): boolean {
  try {
    closeSync(openSync(caminho, "r+"));
    return false;
  } catch (erro) {
    const codigo = (erro as { code?: string }).code;
    return codigo === "EBUSY" || codigo === "EPERM" || codigo === "EACCES";
  }
}

export function verificarTrava(caminho: string, execucaoId: string, pidDono: number): Verificacao[] {
  const segura = travaSegura(caminho);
  const conteudo = lerTrava(caminho);
  return [
    { id: "trava.segura", ok: segura, detalhe: segura ? "trava de restore mantida por um processo" : "trava NÃO está segura (ninguém a mantém)" },
    { id: "trava.execucao", ok: !!conteudo && conteudo.execucaoId === execucaoId && conteudo.livre !== true, detalhe: conteudo ? `trava nomeia a execução ${conteudo.execucaoId ?? "(nenhuma)"}` : "conteúdo da trava ilegível" },
    { id: "trava.dono", ok: !!conteudo && conteudo.pid === pidDono, detalhe: `pid na trava=${conteudo?.pid ?? "?"}; processo chamador=${pidDono}` },
  ];
}
