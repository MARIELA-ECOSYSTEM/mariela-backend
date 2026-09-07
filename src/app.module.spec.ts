import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "./app.module.js";
import { MONGODB_URI_TESTE } from "./test-utils/mongo-teste.util.js";

/**
 * Teste de bootstrap: compila todo o grafo de dependências do `AppModule`
 * (config, JWT, saúde, Produtos, Estoque) contra um MongoDB real de teste.
 *
 * Um dublê de conexão foi cogitado, mas `@nestjs/mongoose` — agora que
 * módulos de negócio registram schemas via `forFeature` — espera uma conexão
 * de verdade (o provider de cada Model é resolvido a partir dela); fingir
 * essa conexão exigiria replicar detalhes internos da biblioteca. Conectar a
 * um MongoDB de teste local é mais simples e também mais fiel.
 */
describe("AppModule", () => {
  let moduleRef: TestingModule | undefined;

  beforeAll(() => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it("compila e conecta com todas as dependências resolvidas", async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
  });
});
