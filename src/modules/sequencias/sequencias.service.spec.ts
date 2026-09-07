import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { SequenciasModule } from "./sequencias.module.js";
import { SequenciasService } from "./sequencias.service.js";

/**
 * Prova que a geração de código é segura sob concorrência: `findOneAndUpdate`
 * + `$inc` + `upsert` é uma única operação atômica no MongoDB — ao contrário
 * de `countDocuments() + 1` (ler a contagem e escrever em passos separados),
 * que colidiria se duas requisições chegassem ao mesmo tempo.
 */
describe("SequenciasService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: SequenciasService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [mongooseModuloDeTeste(), SequenciasModule] }).compile();
    service = moduleRef.get(SequenciasService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("sequencias").deleteMany({});
    await moduleRef.close();
  });

  it("nunca repete nem pula valores sob 20 chamadas concorrentes", async () => {
    const chave = `teste_concorrencia_${Date.now()}`;
    const chamadas = Array.from({ length: 20 }, () => service.proximoCodigo(chave, "TST"));
    const codigos = await Promise.all(chamadas);

    const valores = codigos.map((codigo) => Number(codigo.split("-")[1]));
    const valoresUnicos = new Set(valores);

    expect(codigos).toHaveLength(20);
    expect(valoresUnicos.size).toBe(20); // nenhuma colisão
    expect(Math.min(...valores)).toBe(1);
    expect(Math.max(...valores)).toBe(20); // sequência completa, sem buracos
  });

  it("nunca reaproveita um valor já emitido, mesmo em chamadas sequenciais", async () => {
    const chave = `teste_sequencial_${Date.now()}`;
    const primeiro = await service.proximoCodigo(chave, "TST");
    const segundo = await service.proximoCodigo(chave, "TST");
    expect(primeiro).toBe("TST-0001");
    expect(segundo).toBe("TST-0002");
  });
});
