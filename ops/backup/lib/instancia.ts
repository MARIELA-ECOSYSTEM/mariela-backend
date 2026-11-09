import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Document } from "mongodb";
import type { Verificacao } from "./archive.js";
import { RESTORE } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2.2 (R21-2.1-11) — IDENTIDADE da instância isolada de restore. A porta 27118 sozinha não prova
 * nada: antes de qualquer operação o restore exige que quem responde nela seja a instância instalada pelo
 * `mongod-isolado.ps1` — porta 27118, bind SÓ em 127.0.0.1, `dbPath` = `<raiz>\data-27118` com o marcador de
 * exclusividade, replica set `rs-restore`. (O processo dono da porta é conferido no PowerShell — `Test-InstanciaIsolada`.)
 */

export interface EstadoInstancia {
  porta: number | null;
  bindIp: string | null;
  bindIpAll: boolean;
  dbPath: string | null;
  replSetConfigurado: string | null;
  setName: string | null;
}

export interface EsperadoInstancia {
  porta: number;
  dbPath: string;
  replicaSet: string;
}

export function raizIsolada(raiz?: string): string {
  return raiz && raiz.trim() ? raiz : join(homedir(), "mariela-restore-isolado");
}

export function esperadoPadrao(raiz?: string): EsperadoInstancia {
  return { porta: RESTORE.porta, dbPath: join(raizIsolada(raiz), RESTORE.subdiretorioDados), replicaSet: RESTORE.replicaSet };
}

/** Caminho comparável: absoluto, sem barra final; no Windows, sem diferença de maiúsculas. */
export function normalizarCaminho(caminho: string, insensivel: boolean = process.platform === "win32"): string {
  const r = resolve(caminho).replace(/[\\/]+$/, "");
  return insensivel ? r.toLowerCase() : r;
}

/** Verificações PURAS (testáveis com fixtures). Todas precisam passar. */
export function verificarIdentidadeInstancia(estado: EstadoInstancia, esperado: EsperadoInstancia, marcadorExiste: boolean, insensivel?: boolean): Verificacao[] {
  const binds = (estado.bindIp ?? "").split(",").map((b) => b.trim()).filter(Boolean);
  const bindOk = !estado.bindIpAll && binds.length > 0 && binds.every((b) => b === RESTORE.host);
  const dbPathOk = !!estado.dbPath && normalizarCaminho(estado.dbPath, insensivel) === normalizarCaminho(esperado.dbPath, insensivel);
  return [
    { id: "instancia.porta", ok: estado.porta === esperado.porta, detalhe: `porta=${estado.porta ?? "?"} esperada=${esperado.porta}` },
    { id: "instancia.bind", ok: bindOk, detalhe: `bindIp=${estado.bindIp ?? "?"}${estado.bindIpAll ? " (bindIpAll)" : ""}; exigido só ${RESTORE.host}` },
    { id: "instancia.dbpath", ok: dbPathOk, detalhe: dbPathOk ? "dbPath da instância isolada" : "dbPath diferente do da instância isolada" },
    { id: "instancia.marcador", ok: marcadorExiste, detalhe: marcadorExiste ? "marcador de exclusividade presente" : `marcador ${RESTORE.marcador} ausente no dbPath` },
    {
      id: "instancia.replica_set",
      ok: estado.replSetConfigurado === esperado.replicaSet && estado.setName === esperado.replicaSet,
      detalhe: `configurado=${estado.replSetConfigurado ?? "?"} ativo=${estado.setName ?? "?"} esperado=${esperado.replicaSet}`,
    },
  ];
}

/** Lê o estado da instância conectada (só comandos de diagnóstico). */
export async function lerEstadoInstancia(admin: { command(comando: Document): Promise<Document> }): Promise<EstadoInstancia> {
  const opts = ((await admin.command({ getCmdLineOpts: 1 }))["parsed"] ?? {}) as {
    net?: { bindIp?: string; bindIpAll?: boolean; port?: number };
    storage?: { dbPath?: string };
    replication?: { replSet?: string; replSetName?: string };
  };
  const hello = await admin.command({ hello: 1 });
  return {
    porta: opts.net?.port ?? null,
    bindIp: opts.net?.bindIp ?? null,
    bindIpAll: opts.net?.bindIpAll === true,
    dbPath: opts.storage?.dbPath ?? null,
    replSetConfigurado: opts.replication?.replSet ?? opts.replication?.replSetName ?? null,
    setName: typeof hello["setName"] === "string" ? hello["setName"] : null,
  };
}

/** Lê e verifica a identidade; o marcador é procurado no `dbPath` que a PRÓPRIA instância informa. */
export async function verificarInstanciaConectada(admin: { command(comando: Document): Promise<Document> }, raiz?: string): Promise<Verificacao[]> {
  const estado = await lerEstadoInstancia(admin);
  const marcadorExiste = !!estado.dbPath && existsSync(join(estado.dbPath, RESTORE.marcador));
  return verificarIdentidadeInstancia(estado, esperadoPadrao(raiz), marcadorExiste);
}
