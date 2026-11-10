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
 *   - o dono gravado é o processo PAI desta CLI (o restore que a chamou) — Fase 21.2.6 (A-09): PID **e** horário de
 *     criação do processo (FILETIME do Windows, lido pelo `GetProcessTimes`), para que PID reutilizado não engane.
 * Garantia LOCAL (mesma máquina). Não há exclusão distribuída.
 */

export interface ConteudoTrava {
  execucaoId?: string;
  pid?: number;
  processoInicio?: string;
  /** FILETIME (UTC, 100 ns) da criação do processo dono, em texto decimal. */
  processoInicioTicks?: string;
  banco?: string;
  livre?: boolean;
}

/**
 * Fase 21.2.11 (N1) — operações ADMINISTRATIVAS (desligar, iniciar replica set, configurar autenticação) na instância
 * isolada (27118) exigem a trava; a origem sintética dos testes (27119) não tem trava. PURA.
 */
export function exigeTravaAdministrativa(porta: string | number): boolean {
  return Number(porta) === RESTORE.porta;
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

/**
 * A trava está SEGURA por algum processo? Só a VIOLAÇÃO DE COMPARTILHAMENTO do Windows (ERROR_SHARING_VIOLATION, que o
 * Node/Bun expõe como `EBUSY`) prova que outro handle a mantém aberta. Fase 21.2.8 (A21-7-08): `EPERM`/`EACCES` (ACL,
 * somente-leitura) NÃO contam — não provam que alguém segura a trava.
 */
export function travaSegura(caminho: string): boolean {
  return codigoAberturaTrava(caminho) === "EBUSY";
}

export function codigoAberturaTrava(caminho: string): string | null {
  try {
    closeSync(openSync(caminho, "r+"));
    return null;
  } catch (erro) {
    return (erro as { code?: string }).code ?? "ERRO";
  }
}

/**
 * Horário de criação (FILETIME UTC, 100 ns) de um processo pelo PID, via `GetProcessTimes` — o MESMO valor que o .NET
 * expõe em `Process.StartTime.ToFileTimeUtc()`. `null` se não for possível ler (processo inexistente, sem acesso, ou
 * plataforma sem kernel32): quem chama trata `null` como NÃO comprovado (falha fechada).
 */
export function inicioDoProcesso(pid: number): bigint | null {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const k = dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
      GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    });
    try {
      const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
      const h = k.symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!h) return null;
      const criacao = new BigUint64Array(1);
      const resto = [new BigUint64Array(1), new BigUint64Array(1), new BigUint64Array(1)] as const;
      const ok = k.symbols.GetProcessTimes(h, ptr(criacao), ptr(resto[0]), ptr(resto[1]), ptr(resto[2]));
      k.symbols.CloseHandle(h);
      return ok && criacao[0]! > 0n ? criacao[0]! : null;
    } finally {
      k.close();
    }
  } catch {
    return null;
  }
}

export function verificarTrava(caminho: string, execucaoId: string, pidDono: number, inicioDono: bigint | null = inicioDoProcesso(pidDono)): Verificacao[] {
  const segura = travaSegura(caminho);
  const conteudo = lerTrava(caminho);
  const inicioGravado = conteudo?.processoInicioTicks;
  const inicioOk = !!conteudo && inicioDono !== null && typeof inicioGravado === "string" && /^\d+$/.test(inicioGravado) && BigInt(inicioGravado) === inicioDono;
  return [
    { id: "trava.segura", ok: segura, detalhe: segura ? "trava de restore mantida por um processo" : "trava NÃO está segura (ninguém a mantém)" },
    { id: "trava.execucao", ok: !!conteudo && conteudo.execucaoId === execucaoId && conteudo.livre !== true, detalhe: conteudo ? `trava nomeia a execução ${conteudo.execucaoId ?? "(nenhuma)"}` : "conteúdo da trava ilegível" },
    { id: "trava.dono", ok: !!conteudo && conteudo.pid === pidDono, detalhe: `pid na trava=${conteudo?.pid ?? "?"}; processo chamador=${pidDono}` },
    {
      id: "trava.dono_inicio",
      ok: inicioOk,
      detalhe: inicioOk ? "horário de criação do processo dono confere (PID não reutilizado)" : `horário de criação não confere ou ilegível (gravado=${inicioGravado ?? "?"}; atual=${inicioDono ?? "?"})`,
    },
  ];
}
