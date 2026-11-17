import "reflect-metadata";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import mongoose from "mongoose";
import { DatabaseModule } from "../database/database.module.js";
import configuration from "./configuration.js";
import { validateEnv } from "./env.validation.js";

/**
 * Fase 22.8.9.2 (B-02) — a recusa do banco em produção acontece ANTES de qualquer tentativa de conexão.
 *
 * Monta o mesmo par do `AppModule` — `ConfigModule.forRoot({ load: [configuration], validate: validateEnv })` real
 * seguido do `DatabaseModule` real — com `mongoose.createConnection` substituído por um dublê: nenhum teste aqui
 * abre socket, resolve DNS ou toca qualquer MongoDB (local, Atlas ou outro). O controle positivo prova que o dublê
 * enxerga a tentativa de conexão quando a configuração é válida; os negativos provam que ela nem chega a acontecer.
 * `.env` nunca é lido (`ignoreEnvFile`); as variáveis do teste são postas e retiradas de `process.env`.
 */

const SEGREDO = "s".repeat(32);
const HOST_FICTICIO = "mongodb+srv://usuario:senha-ficticia@cluster0.exemplo.invalid";

const ENV_PRODUCAO = {
  NODE_ENV: "production",
  JWT_ACCESS_SECRET: `${SEGREDO}-a`,
  JWT_REFRESH_SECRET: `${SEGREDO}-r`,
  PDV_JWT_ACCESS_SECRET: `${SEGREDO}-pa`,
  PDV_JWT_REFRESH_SECRET: `${SEGREDO}-pr`,
};

const ambienteOriginal = { ...process.env };
let moduleRef: TestingModule | undefined;

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = undefined;
  for (const chave of Object.keys(process.env)) if (!(chave in ambienteOriginal)) delete process.env[chave];
  Object.assign(process.env, ambienteOriginal);
});

/**
 * Dublê de conexão, sem rede. Intercepta na CLASSE `Connection` (`openUri`/`close`), que é a mesma para qualquer
 * forma de import do mongoose — espionar `mongoose.createConnection` no export default NÃO intercepta o
 * `import * as mongoose` do `@nestjs/mongoose` (verificado pelo controle positivo). Tripwire extra: se o driver
 * chegasse a `MongoClient.connect`, o teste falha.
 */
function espionarConexao() {
  const proto = mongoose.Connection.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const openUri = spyOn(proto, "openUri").mockImplementation(function (this: { $initialConnection?: unknown }) {
    this.$initialConnection = Promise.resolve(this);
    return Promise.resolve(this);
  } as never);
  const close = spyOn(proto, "close").mockImplementation((async () => undefined) as never);
  const driver = spyOn(mongoose.mongo.MongoClient.prototype, "connect").mockImplementation((() => {
    throw new Error("TRIPWIRE: o driver tentou conectar");
  }) as never);
  return {
    tentativas: openUri,
    driver,
    mockRestore() {
      openUri.mockRestore();
      close.mockRestore();
      driver.mockRestore();
    },
  };
}

async function subir(env: Record<string, string>): Promise<TestingModule> {
  for (const chave of ["MONGODB_URI", ...Object.keys(ENV_PRODUCAO)]) delete process.env[chave];
  Object.assign(process.env, env);
  return Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [configuration], validate: validateEnv }), DatabaseModule],
  }).compile();
}

describe("Fase 22.8.9.2 (B-02) — recusa do banco em produção acontece antes da conexão", () => {
  it("controle positivo: produção + marielaDB chega à conexão (o dublê a registra)", async () => {
    const conexao = espionarConexao();
    try {
      moduleRef = await subir({ ...ENV_PRODUCAO, MONGODB_URI: `${HOST_FICTICIO}/marielaDB?retryWrites=true` });
      expect(conexao.tentativas).toHaveBeenCalledTimes(1);
      expect(conexao.driver).not.toHaveBeenCalled();
      await moduleRef.close();
      moduleRef = undefined;
      expect(conexao.tentativas.mock.calls[0]![0]).toBe(`${HOST_FICTICIO}/marielaDB?retryWrites=true`);
    } finally {
      conexao.mockRestore();
    }
  });

  for (const [cenario, caminho] of [
    ["banco test", "/test"],
    ["outro banco", "/outroBanco"],
    ["mesmo nome com outra caixa", "/MarielaDB"],
  ] as const) {
    it(`produção + ${cenario}: a subida é recusada e nenhuma conexão é tentada`, async () => {
      const conexao = espionarConexao();
      try {
        await expect(subir({ ...ENV_PRODUCAO, MONGODB_URI: `${HOST_FICTICIO}${caminho}?retryWrites=true` })).rejects.toThrow(
          /deve apontar para o banco "marielaDB"/,
        );
        expect(conexao.tentativas).not.toHaveBeenCalled();
      expect(conexao.driver).not.toHaveBeenCalled();
      } finally {
        conexao.mockRestore();
      }
    });
  }

  it("produção sem banco no path: recusada (validação de formato) e nenhuma conexão é tentada", async () => {
    const conexao = espionarConexao();
    try {
      await expect(subir({ ...ENV_PRODUCAO, MONGODB_URI: `${HOST_FICTICIO}/?retryWrites=true` })).rejects.toThrow(/MONGODB_URI/);
      expect(conexao.tentativas).not.toHaveBeenCalled();
      expect(conexao.driver).not.toHaveBeenCalled();
    } finally {
      conexao.mockRestore();
    }
  });

  it("teste + banco descartável: segue para a conexão como antes (flexibilidade preservada)", async () => {
    const conexao = espionarConexao();
    try {
      moduleRef = await subir({ ...ENV_PRODUCAO, NODE_ENV: "test", MONGODB_URI: "mongodb://mongo-descartavel.invalid:27017/mariela_test_descartavel" });
      expect(conexao.tentativas).toHaveBeenCalledTimes(1);
      expect(conexao.driver).not.toHaveBeenCalled();
      await moduleRef.close();
      moduleRef = undefined;
    } finally {
      conexao.mockRestore();
    }
  });
});
