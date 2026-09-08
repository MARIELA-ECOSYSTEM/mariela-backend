import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getConnectionToken, MongooseModule } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import type { DadosCriarMovimento } from "./caixas.types.js";
import { MovimentosCaixaRepository } from "./movimentos-caixa.repository.js";
import { MovimentoCaixa, MovimentoCaixaSchema } from "./schemas/movimento-caixa.schema.js";

/**
 * Etapa 10.2 — bugfix pontual de robustez de idempotência em
 * `MovimentosCaixaRepository.criar`. Mesmo padrão dos testes de concorrência
 * de idempotência já existentes em `vendas.service.spec.ts`/
 * `pdv-vendas.service.spec.ts`, aplicado ao repository de movimentos de
 * caixa (aqui não é preciso subir `CaixasModule` inteiro — só o schema sob
 * teste — porque a garantia é inteiramente do repository, sem regra de
 * negócio de `CaixasService` envolvida).
 */
describe("MovimentosCaixaRepository (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let repository: MovimentosCaixaRepository;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), MongooseModule.forFeature([{ name: MovimentoCaixa.name, schema: MovimentoCaixaSchema }])],
      providers: [MovimentosCaixaRepository],
    }).compile();
    repository = moduleRef.get(MovimentosCaixaRepository);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("movimentos_caixa").deleteMany({});
    await moduleRef.close();
  });

  function payloadMovimento(caixaId: string, extra: Partial<DadosCriarMovimento> = {}): DadosCriarMovimento {
    return {
      caixaId,
      dataHora: new Date(),
      tipo: "venda",
      origem: "venda",
      descricao: "Movimento de teste",
      referencia: null,
      vendaId: null,
      vendaCodigo: null,
      formaPagamento: "Dinheiro",
      valor: 100,
      sentido: "entrada",
      responsavelId: null,
      responsavelNome: "Backoffice",
      observacao: "",
      motivo: null,
      idempotencyKey: null,
      ...extra,
    };
  }

  describe("comportamento normal", () => {
    it("chaves diferentes criam movimentos independentes", async () => {
      const caixaId = new Types.ObjectId().toString();
      const a = await repository.criar(payloadMovimento(caixaId, { idempotencyKey: "chave-a" }));
      const b = await repository.criar(payloadMovimento(caixaId, { idempotencyKey: "chave-b" }));

      expect(a.duplicado).toBe(false);
      expect(b.duplicado).toBe(false);
      expect(String(a.movimento._id)).not.toBe(String(b.movimento._id));

      const total = await connection.collection("movimentos_caixa").countDocuments({ caixaId: new Types.ObjectId(caixaId) });
      expect(total).toBe(2);
    });

    it("sem idempotencyKey, cada chamada cria um movimento novo", async () => {
      const caixaId = new Types.ObjectId().toString();
      const a = await repository.criar(payloadMovimento(caixaId));
      const b = await repository.criar(payloadMovimento(caixaId));
      expect(a.duplicado).toBe(false);
      expect(b.duplicado).toBe(false);
      expect(String(a.movimento._id)).not.toBe(String(b.movimento._id));
    });

    it("mesma chave após persistência: a segunda chamada devolve o existente, sem criar outro documento", async () => {
      const caixaId = new Types.ObjectId().toString();
      const chave = `chave-sequencial-${Date.now()}`;

      const primeira = await repository.criar(payloadMovimento(caixaId, { idempotencyKey: chave, descricao: "Original" }));
      const segunda = await repository.criar(payloadMovimento(caixaId, { idempotencyKey: chave, descricao: "Retry" }));

      expect(primeira.duplicado).toBe(false);
      expect(segunda.duplicado).toBe(true);
      expect(String(segunda.movimento._id)).toBe(String(primeira.movimento._id));
      expect(segunda.movimento.descricao).toBe("Original"); // devolveu o vencedor, não recriou com os dados do retry

      const total = await connection.collection("movimentos_caixa").countDocuments({ caixaId: new Types.ObjectId(caixaId), idempotencyKey: chave });
      expect(total).toBe(1);
    });
  });

  describe("concorrência de idempotência (Etapa 10.2)", () => {
    it("duas requisições CONCORRENTES com a mesma chave: uma única movimentação persistida, ambas devolvem o mesmo vencedor", async () => {
      const caixaId = new Types.ObjectId().toString();
      const chave = `chave-concorrencia-${Date.now()}`;

      const [a, b] = await Promise.all([
        repository.criar(payloadMovimento(caixaId, { idempotencyKey: chave, descricao: "Requisição A" })),
        repository.criar(payloadMovimento(caixaId, { idempotencyKey: chave, descricao: "Requisição B" })),
      ]);

      // Nenhuma das duas deve ter lançado (Promise.all já teria rejeitado) e
      // ambas apontam para o MESMO documento — a "vencedora" da corrida.
      expect(String(a.movimento._id)).toBe(String(b.movimento._id));
      expect(a.movimento.descricao).toBe(b.movimento.descricao);

      const total = await connection.collection("movimentos_caixa").countDocuments({ caixaId: new Types.ObjectId(caixaId), idempotencyKey: chave });
      expect(total).toBe(1);
    });

    it("concorrência real com múltiplas chamadas simultâneas (5x a mesma chave): exatamente 1 documento", async () => {
      const caixaId = new Types.ObjectId().toString();
      const chave = `chave-concorrencia-multipla-${Date.now()}`;

      const resultados = await Promise.all(
        Array.from({ length: 5 }, (_, indice) => repository.criar(payloadMovimento(caixaId, { idempotencyKey: chave, descricao: `Tentativa ${indice}` }))),
      );

      const idsUnicos = new Set(resultados.map((resultado) => String(resultado.movimento._id)));
      expect(idsUnicos.size).toBe(1);

      const total = await connection.collection("movimentos_caixa").countDocuments({ caixaId: new Types.ObjectId(caixaId), idempotencyKey: chave });
      expect(total).toBe(1);
    });
  });
});
