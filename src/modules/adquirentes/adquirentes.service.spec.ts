import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { AdquirentesModule } from "./adquirentes.module.js";
import { AdquirentesService } from "./adquirentes.service.js";
import type { CriarAdquirenteDto } from "./dto/criar-adquirente.dto.js";
import type { ListarAdquirentesQueryDto } from "./dto/listar-adquirentes-query.dto.js";

// `AdquirentesController` usa `@UseGuards(JwtAuthGuard)`, que injeta
// `JwtService` — só disponível globalmente via `AppModule` de verdade. Este
// teste foca no service, então basta um `JwtModule` local mínimo (mesmo
// padrão de `colecoes.service.spec.ts`).
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

function payloadAdquirente(sufixo: string, extra: Partial<CriarAdquirenteDto> = {}): CriarAdquirenteDto {
  return {
    nome: `Adquirente Teste ${sufixo}`,
    ...extra,
  };
}

function queryPadrao(extra: Partial<ListarAdquirentesQueryDto> = {}): ListarAdquirentesQueryDto {
  return { page: 1, limit: 20, ...extra };
}

describe("AdquirentesService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: AdquirentesService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, AdquirentesModule],
    }).compile();
    service = moduleRef.get(AdquirentesService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("adquirentes").deleteMany({});
    await connection.collection("eventos_adquirente").deleteMany({});
    await moduleRef.close();
  });

  describe("criação", () => {
    it("cria uma adquirente válida", async () => {
      const criada = await service.criar(payloadAdquirente("Criação Básica"), null);
      expect(criada.id).toBeTruthy();
      expect(criada.nome).toBe("Adquirente Teste Criação Básica");
      expect(criada.ativo).toBe(true);
      expect(criada.observacao).toBeNull();
      expect(criada.tabelaTarifas).toEqual([]);
      expect(criada.excluidoEm).toBeNull();
    });

    it("aplica trim no nome", async () => {
      const criada = await service.criar(payloadAdquirente("Trim", { nome: "  Adquirente Trim  " }), null);
      expect(criada.nome).toBe("Adquirente Trim");
    });

    it("rejeita nome duplicado (exato)", async () => {
      await service.criar(payloadAdquirente("Duplicada"), null);
      await expect(service.criar(payloadAdquirente("Duplicada"), null)).rejects.toBeInstanceOf(ApiException);
    });

    it("rejeita nome duplicado ignorando maiúsculas/minúsculas", async () => {
      await service.criar(payloadAdquirente("CaseInsensitive", { nome: "Cielo Teste XYZ" }), null);
      await expect(service.criar(payloadAdquirente("x", { nome: "cielo teste xyz" }), null)).rejects.toBeInstanceOf(ApiException);
      await expect(service.criar(payloadAdquirente("x", { nome: "CIELO TESTE XYZ" }), null)).rejects.toBeInstanceOf(ApiException);
    });

    it("permite cadastrar sem tabela de tarifas e configurar depois", async () => {
      const criada = await service.criar(payloadAdquirente("Sem Tarifa"), null);
      expect(criada.tabelaTarifas).toEqual([]);
      const atualizada = await service.atualizar(
        criada.id,
        { tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.5 }] },
        null,
      );
      expect(atualizada.tabelaTarifas).toHaveLength(1);
    });
  });

  describe("tarifas", () => {
    it("permite débito 1x", async () => {
      const criada = await service.criar(
        payloadAdquirente("Debito1x", { tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1.99 }] }),
        null,
      );
      expect(criada.tabelaTarifas[0]).toMatchObject({ modalidade: "debito", parcelas: 1, percentual: 1.99 });
    });

    it("rejeita débito com 2x", async () => {
      await expect(
        service.criar(
          payloadAdquirente("Debito2x", { tabelaTarifas: [{ modalidade: "debito", parcelas: 2, percentual: 1.99 }] }),
          null,
        ),
      ).rejects.toBeInstanceOf(ApiException);
    });

    it("permite crédito de 1x", async () => {
      const criada = await service.criar(
        payloadAdquirente("Credito1x", { tabelaTarifas: [{ modalidade: "credito", parcelas: 1, percentual: 3.49 }] }),
        null,
      );
      expect(criada.tabelaTarifas).toHaveLength(1);
    });

    it("permite crédito de 24x", async () => {
      const criada = await service.criar(
        payloadAdquirente("Credito24x", { tabelaTarifas: [{ modalidade: "credito", parcelas: 24, percentual: 12 }] }),
        null,
      );
      expect(criada.tabelaTarifas).toHaveLength(1);
    });

    it("aceita diferentes tarifas para diferentes parcelas", async () => {
      const criada = await service.criar(
        payloadAdquirente("VariasParcelas", {
          tabelaTarifas: [
            { modalidade: "debito", parcelas: 1, percentual: 1.99 },
            { modalidade: "credito", parcelas: 1, percentual: 3.49 },
            { modalidade: "credito", parcelas: 2, percentual: 4.49 },
            { modalidade: "credito", parcelas: 6, percentual: 5.99 },
          ],
        }),
        null,
      );
      expect(criada.tabelaTarifas).toHaveLength(4);
    });

    it("rejeita duplicidade de modalidade + parcelas", async () => {
      await expect(
        service.criar(
          payloadAdquirente("DuplicidadeTarifa", {
            tabelaTarifas: [
              { modalidade: "credito", parcelas: 6, percentual: 5 },
              { modalidade: "credito", parcelas: 6, percentual: 6 },
            ],
          }),
          null,
        ),
      ).rejects.toBeInstanceOf(ApiException);
    });
  });

  describe("atualização", () => {
    it("atualiza nome", async () => {
      const criada = await service.criar(payloadAdquirente("AtualizarNome"), null);
      const atualizada = await service.atualizar(criada.id, { nome: "Nome Atualizado XYZ" }, null);
      expect(atualizada.nome).toBe("Nome Atualizado XYZ");
    });

    it("atualiza observação", async () => {
      const criada = await service.criar(payloadAdquirente("AtualizarObs"), null);
      const atualizada = await service.atualizar(criada.id, { observacao: "Recebimento D+1" }, null);
      expect(atualizada.observacao).toBe("Recebimento D+1");
    });

    it("atualiza ativo", async () => {
      const criada = await service.criar(payloadAdquirente("AtualizarAtivo"), null);
      const atualizada = await service.atualizar(criada.id, { ativo: false }, null);
      expect(atualizada.ativo).toBe(false);
    });

    it("substitui a tabela de tarifas inteira", async () => {
      const criada = await service.criar(
        payloadAdquirente("SubstituirTarifas", {
          tabelaTarifas: [{ modalidade: "debito", parcelas: 1, percentual: 1 }],
        }),
        null,
      );
      const atualizada = await service.atualizar(
        criada.id,
        { tabelaTarifas: [{ modalidade: "credito", parcelas: 3, percentual: 4.99 }] },
        null,
      );
      expect(atualizada.tabelaTarifas).toHaveLength(1);
      expect(atualizada.tabelaTarifas[0]).toMatchObject({ modalidade: "credito", parcelas: 3, percentual: 4.99 });
    });

    it("revalida a tabela inteira durante a atualização (rejeita débito 2x mesmo em PATCH)", async () => {
      const criada = await service.criar(payloadAdquirente("RevalidarPatch"), null);
      await expect(
        service.atualizar(criada.id, { tabelaTarifas: [{ modalidade: "debito", parcelas: 3, percentual: 1 }] }, null),
      ).rejects.toBeInstanceOf(ApiException);
    });

    it("não altera nome ao atualizar só outro campo (PATCH genuinamente parcial)", async () => {
      const criada = await service.criar(payloadAdquirente("PatchParcial"), null);
      const atualizada = await service.atualizar(criada.id, { ativo: false }, null);
      expect(atualizada.nome).toBe(criada.nome);
    });
  });

  describe("soft delete", () => {
    it("exclui sem apagar fisicamente (documento continua existindo no Mongo)", async () => {
      const criada = await service.criar(payloadAdquirente("SoftDelete"), null);
      await service.excluir(criada.id, null);
      const bruto = await connection.collection("adquirentes").findOne({ _id: new (await import("mongoose")).Types.ObjectId(criada.id) });
      expect(bruto).not.toBeNull();
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });

    it("adquirente excluída não aparece na listagem normal", async () => {
      const criada = await service.criar(payloadAdquirente("SoftDeleteListagem"), null);
      await service.excluir(criada.id, null);
      const resultado = await service.listar(queryPadrao({ busca: criada.nome }));
      expect(resultado.data).toHaveLength(0);
    });

    it("adquirente excluída não pode ser utilizada futuramente (obterPorId lança 404)", async () => {
      const criada = await service.criar(payloadAdquirente("SoftDeleteUso"), null);
      await service.excluir(criada.id, null);
      await expect(service.obterPorId(criada.id)).rejects.toBeInstanceOf(ApiException);
    });

    it("não permite excluir uma adquirente já excluída (segunda exclusão falha)", async () => {
      const criada = await service.criar(payloadAdquirente("SoftDeleteDuplicado"), null);
      await service.excluir(criada.id, null);
      await expect(service.excluir(criada.id, null)).rejects.toBeInstanceOf(ApiException);
    });

    it("libera o nome para reuso após exclusão", async () => {
      const criada = await service.criar(payloadAdquirente("ReusoNome", { nome: "Adquirente Reusável XYZ" }), null);
      await service.excluir(criada.id, null);
      const recriada = await service.criar(payloadAdquirente("ReusoNome2", { nome: "Adquirente Reusável XYZ" }), null);
      expect(recriada.id).not.toBe(criada.id);
    });
  });

  describe("listagem", () => {
    it("pagina os resultados", async () => {
      for (let indice = 0; indice < 3; indice += 1) {
        await service.criar(payloadAdquirente(`Paginacao${indice}`, { nome: `Adquirente Paginação ${indice} XYZ` }), null);
      }
      const pagina1 = await service.listar(queryPadrao({ busca: "Adquirente Paginação", limit: 2, page: 1 }));
      expect(pagina1.data).toHaveLength(2);
      expect(pagina1.meta.total).toBe(3);
      const pagina2 = await service.listar(queryPadrao({ busca: "Adquirente Paginação", limit: 2, page: 2 }));
      expect(pagina2.data).toHaveLength(1);
    });
  });
});
