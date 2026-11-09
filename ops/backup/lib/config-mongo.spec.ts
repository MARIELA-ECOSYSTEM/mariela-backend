import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bancoDaUri, ConfigMongoErro, extrairUriDoYaml, lerConfigMongo, sanitizarMensagem } from "./config-mongo.js";

/** Fase 60.4.3.4.21.2 — config do mongodump (`--config`): banco exatamente `marielaDB`, URI nunca em mensagens. */

const URI_FALSA = "mongodb+srv://usuario-falso:senha-falsa@cluster-falso.exemplo.mongodb.net/marielaDB?retryWrites=true";

describe("config do mongodump", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("extrai a URI com e sem aspas; sem chave → URI_AUSENTE", () => {
    expect(extrairUriDoYaml(`uri: "${URI_FALSA}"\n`)).toBe(URI_FALSA);
    expect(extrairUriDoYaml(`# comentario\nuri: ${URI_FALSA}\r\n`)).toBe(URI_FALSA);
    expect(() => extrairUriDoYaml("password: x\n")).toThrow(ConfigMongoErro);
  });

  it("banco da URI: srv e padrão; ausente → BANCO_AUSENTE; esquema errado → URI_INVALIDA", () => {
    expect(bancoDaUri(URI_FALSA)).toBe("marielaDB");
    expect(bancoDaUri("mongodb://127.0.0.1:27119/marielaDB")).toBe("marielaDB");
    expect(() => bancoDaUri("mongodb://127.0.0.1:27119/")).toThrow(/não define o banco/);
    expect(() => bancoDaUri("mongodb://127.0.0.1:27119")).toThrow(/não define o banco/);
    expect(() => bancoDaUri("http://x/marielaDB")).toThrow(/não é mongodb/);
  });

  it("banco diferente de marielaDB (inclusive `test`) → BANCO_DIVERGENTE, sem expor a URI", () => {
    dir = mkdtempSync(join(tmpdir(), "config-"));
    const arq = join(dir, "c.yaml");
    writeFileSync(arq, `uri: "${URI_FALSA.replace("/marielaDB", "/test")}"\n`);
    try {
      lerConfigMongo(arq, "marielaDB");
      throw new Error("não lançou");
    } catch (erro) {
      expect(erro).toBeInstanceOf(ConfigMongoErro);
      expect((erro as ConfigMongoErro).codigo).toBe("BANCO_DIVERGENTE");
      expect((erro as Error).message).not.toContain("senha-falsa");
      expect((erro as Error).message).not.toContain("cluster-falso");
    }
    writeFileSync(arq, `uri: "${URI_FALSA}"\n`);
    expect(lerConfigMongo(arq, "marielaDB").banco).toBe("marielaDB");
  });

  it("sanitizarMensagem remove URI, host e IP", () => {
    const s = sanitizarMensagem(`falhou ${URI_FALSA} em cluster0-shard-00-01.abcde.mongodb.net:27017 via 10.1.2.3:27017`);
    expect(s).not.toContain("senha-falsa");
    expect(s).not.toContain("abcde");
    expect(s).not.toContain("10.1.2.3");
  });
});
