import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Document } from "mongodb";
import { esperadoPadrao, lerEstadoInstancia, verificarIdentidadeInstancia, type EstadoInstancia } from "./instancia.js";

/** Fase 60.4.3.4.21.2.2 (R21-2.1-11) — identidade da instância isolada, com fixtures (sem MongoDB). */

const RAIZ = join("C:", "Users", "operador", "mariela-restore-isolado");
const ESPERADO = esperadoPadrao(RAIZ);
const CORRETO: EstadoInstancia = { porta: 27118, bindIp: "127.0.0.1", bindIpAll: false, dbPath: ESPERADO.dbPath, replSetConfigurado: "rs-restore", setName: "rs-restore" };
const falhas = (estado: EstadoInstancia, marcador = true, insensivel = true) =>
  verificarIdentidadeInstancia(estado, ESPERADO, marcador, insensivel).filter((v) => !v.ok).map((v) => v.id);

describe("identidade da instância isolada", () => {
  it("instância correta → todas as verificações OK", () => {
    expect(falhas(CORRETO)).toEqual([]);
    expect(ESPERADO).toMatchObject({ porta: 27118, replicaSet: "rs-restore" });
    expect(ESPERADO.dbPath.endsWith("data-27118")).toBe(true);
  });

  it("outra porta → recusa", () => {
    expect(falhas({ ...CORRETO, porta: 27017 })).toEqual(["instancia.porta"]);
  });

  it("bind incorreto: 0.0.0.0, lista com interface externa, bindIpAll ou ausente → recusa", () => {
    expect(falhas({ ...CORRETO, bindIp: "0.0.0.0" })).toEqual(["instancia.bind"]);
    expect(falhas({ ...CORRETO, bindIp: "127.0.0.1,192.168.0.10" })).toEqual(["instancia.bind"]);
    expect(falhas({ ...CORRETO, bindIpAll: true })).toEqual(["instancia.bind"]);
    expect(falhas({ ...CORRETO, bindIp: null })).toEqual(["instancia.bind"]);
  });

  it("dbPath divergente ou ausente → recusa; diferença só de maiúsculas é aceita no Windows (e não fora dele)", () => {
    expect(falhas({ ...CORRETO, dbPath: join(RAIZ, "outro-dbpath") })).toEqual(["instancia.dbpath"]);
    expect(falhas({ ...CORRETO, dbPath: null })).toEqual(["instancia.dbpath"]);
    const maiusculas = { ...CORRETO, dbPath: ESPERADO.dbPath.toUpperCase() };
    expect(falhas(maiusculas, true, true)).toEqual([]);
    expect(falhas(maiusculas, true, false)).toEqual(["instancia.dbpath"]);
    expect(falhas({ ...CORRETO, dbPath: `${ESPERADO.dbPath}\\` })).toEqual([]); // barra final não importa
  });

  it("marcador de exclusividade ausente → recusa", () => {
    expect(falhas(CORRETO, false)).toEqual(["instancia.marcador"]);
  });

  it("replica set inesperado (configurado ou ativo) ou standalone → recusa", () => {
    expect(falhas({ ...CORRETO, replSetConfigurado: "rs0", setName: "rs0" })).toEqual(["instancia.replica_set"]);
    expect(falhas({ ...CORRETO, setName: null })).toEqual(["instancia.replica_set"]);
    expect(falhas({ ...CORRETO, replSetConfigurado: null, setName: null })).toEqual(["instancia.replica_set"]);
  });

  it("lerEstadoInstancia extrai getCmdLineOpts + hello (comando de diagnóstico simulado)", async () => {
    const admin = {
      async command(c: Document): Promise<Document> {
        if (c["getCmdLineOpts"]) return { parsed: { net: { bindIp: "127.0.0.1", port: 27118 }, storage: { dbPath: ESPERADO.dbPath }, replication: { replSet: "rs-restore" } } };
        if (c["hello"]) return { setName: "rs-restore", isWritablePrimary: true };
        throw new Error("comando inesperado");
      },
    };
    expect(await lerEstadoInstancia(admin)).toEqual(CORRETO);
  });
});
