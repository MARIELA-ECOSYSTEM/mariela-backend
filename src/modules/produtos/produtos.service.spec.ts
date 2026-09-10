import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { CriarProdutoDto } from "./dto/criar-produto.dto.js";
import { ProdutosModule } from "./produtos.module.js";
import { ProdutosService } from "./produtos.service.js";

// `ProdutosController` usa `@UseGuards(JwtAuthGuard)`, que injeta `JwtService`
// — só disponível globalmente via `AppModule` de verdade. Este teste foca no
// service (não no HTTP/guard), então basta um `JwtModule` local mínimo para o
// grafo de DI compilar; nenhum token é de fato emitido/validado aqui.
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

function payloadProduto(sufixo: string, extra: Partial<CriarProdutoDto> = {}): CriarProdutoDto {
  return {
    nome: `Vestido Teste ${sufixo}`,
    categoria: "Vestidos",
    precoCusto: 50,
    precoVenda: 100,
    ehNovidade: false,
    ...extra,
  };
}

describe("ProdutosService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: ProdutosService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, ProdutosModule],
    }).compile();
    service = moduleRef.get(ProdutosService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("sequencias").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await moduleRef.close();
  });

  describe("criação e código", () => {
    it("cria um produto sem estoque nem variantes, com código sequencial gerado pelo backend", async () => {
      const produto = await service.criar(payloadProduto("A"), null);
      expect(produto.codProduto).toMatch(/^PROD-\d{4}$/);
      expect(produto.quantidadeTotal).toBe(0);
      expect(produto.variantes).toHaveLength(0);
      expect(produto.ehPromocao).toBe(false);
      expect(produto.estoqueZeradoEm).toBeNull();
    });

    it("gera códigos distintos e sequenciais para produtos sucessivos", async () => {
      const primeiro = await service.criar(payloadProduto("B1"), null);
      const segundo = await service.criar(payloadProduto("B2"), null);
      const seqPrimeiro = Number(primeiro.codProduto.split("-")[1]);
      const seqSegundo = Number(segundo.codProduto.split("-")[1]);
      expect(seqSegundo).toBe(seqPrimeiro + 1);
    });

    it("calcula a margem sobre o preço de venda na criação", async () => {
      const produto = await service.criar(payloadProduto("C", { precoCusto: 50, precoVenda: 100 }), null);
      expect(produto.margemLucro).toBe(50);
    });
  });

  describe("busca e listagem", () => {
    it("busca um produto pelo id", async () => {
      const criado = await service.criar(payloadProduto("D"), null);
      const encontrado = await service.obterPorId(criado.id);
      expect(encontrado.codProduto).toBe(criado.codProduto);
    });

    it("lança NOT_FOUND para um id inexistente", async () => {
      await expect(service.obterPorId("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("lista produtos com paginação e meta", async () => {
      const nomeUnico = `Listagem ${Date.now()}`;
      await service.criar(payloadProduto("E", { nome: nomeUnico }), null);
      const resultado = await service.listar({
        busca: nomeUnico,
        ordenarPor: "nome",
        ordem: "asc",
        page: 1,
        limit: 20,
        categorias: [],
        colecoes: [],
        campanhas: [],
        fornecedores: [],
        estoque: [],
        promocao: [],
        novidade: [],
      });
      expect(resultado.data).toHaveLength(1);
      expect(resultado.meta.total).toBe(1);
      expect(resultado.meta.page).toBe(1);
    });
  });

  describe("atualização e validação", () => {
    it("atualiza os dados cadastrais e recalcula a margem", async () => {
      const criado = await service.criar(payloadProduto("F", { precoCusto: 50, precoVenda: 100 }), null);
      const atualizado = await service.atualizar(criado.id, payloadProduto("F", { precoCusto: 60, precoVenda: 120 }), null);
      expect(atualizado.precoVenda).toBe(120);
      expect(atualizado.margemLucro).toBe(50);
    });

    it("rejeita reduzir o preço de venda abaixo do preço promocional ativo", async () => {
      const criado = await service.criar(payloadProduto("G", { precoCusto: 50, precoVenda: 100 }), null);
      await service.definirPromocao(criado.id, { ehPromocao: true, precoPromocional: 80 }, null);
      await expect(
        service.atualizar(criado.id, payloadProduto("G", { precoCusto: 50, precoVenda: 70 }), null),
      ).rejects.toThrow(ApiException);
    });
  });

  describe("exclusão (soft delete)", () => {
    it("some da listagem/detalhe após excluído, mas o documento continua no banco", async () => {
      const criado = await service.criar(payloadProduto("H"), null);
      await service.excluir(criado.id, null);
      await expect(service.obterPorId(criado.id)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("produtos").findOne({ codProduto: criado.codProduto });
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });
  });

  describe("variantes", () => {
    it("adiciona uma variante e deriva o código a partir do código do produto", async () => {
      const produto = await service.criar(payloadProduto("I"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Azul Marinho" }, null);
      expect(variante.codVariante).toBe(`${produto.codProduto}-AZUL-MARINHO`);
      expect(variante.quantidadeVariante).toBe(0);
    });

    it("impede duas variantes com a mesma cor (mesmo case)", async () => {
      const produto = await service.criar(payloadProduto("J"), null);
      await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      await expect(service.adicionarVariante(produto.id, { cor: "Preto" }, null)).rejects.toThrow(ApiException);
    });

    it("impede cor duplicada ignorando maiúsculas/minúsculas e acentos", async () => {
      const produto = await service.criar(payloadProduto("K"), null);
      await service.adicionarVariante(produto.id, { cor: "Rosé" }, null);
      await expect(service.adicionarVariante(produto.id, { cor: "  ROSE " }, null)).rejects.toThrow(ApiException);
    });

    it("permite a mesma cor em produtos DIFERENTES", async () => {
      const produtoA = await service.criar(payloadProduto("L1"), null);
      const produtoB = await service.criar(payloadProduto("L2"), null);
      await service.adicionarVariante(produtoA.id, { cor: "Verde" }, null);
      const variante = await service.adicionarVariante(produtoB.id, { cor: "Verde" }, null);
      expect(variante.cor).toBe("Verde");
    });
  });

  describe("tamanhos e estoque derivado", () => {
    it("normaliza o tamanho ao adicionar", async () => {
      const produto = await service.criar(payloadProduto("M"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      const varianteComTamanho = await service.adicionarTamanho(produto.id, String(variante._id), {
        tamanho: " m ",
        quantidade: 5,
      }, null);
      expect(varianteComTamanho.tamanhos[0]?.tamanho).toBe("M");
    });

    it("impede tamanho duplicado na mesma variante", async () => {
      const produto = await service.criar(payloadProduto("N"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      await service.adicionarTamanho(produto.id, String(variante._id), { tamanho: "P", quantidade: 3 }, null);
      await expect(
        service.adicionarTamanho(produto.id, String(variante._id), { tamanho: "p", quantidade: 1 }, null),
      ).rejects.toThrow(ApiException);
    });

    it("impede o tamanho único (U) de coexistir com outros tamanhos", async () => {
      const produto = await service.criar(payloadProduto("O"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      await service.adicionarTamanho(produto.id, String(variante._id), { tamanho: "P", quantidade: 3 }, null);
      await expect(service.adicionarTamanho(produto.id, String(variante._id), { tamanho: "U", quantidade: 1 }, null)).rejects.toThrow(
        ApiException,
      );
    });

    it("calcula quantidadeVariante (soma dos tamanhos) e quantidadeTotal (soma das variantes)", async () => {
      const produto = await service.criar(payloadProduto("P"), null);
      const preta = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      await service.adicionarTamanho(produto.id, String(preta._id), { tamanho: "P", quantidade: 4 }, null);
      await service.adicionarTamanho(produto.id, String(preta._id), { tamanho: "M", quantidade: 6 }, null);
      const branca = await service.adicionarVariante(produto.id, { cor: "Branco" }, null);
      await service.adicionarTamanho(produto.id, String(branca._id), { tamanho: "M", quantidade: 3 }, null);

      const final = await service.obterPorId(produto.id);
      const varPreta = final.variantes.find((v) => v.cor === "Preto")!;
      expect(varPreta.quantidadeVariante).toBe(10);
      expect(final.quantidadeTotal).toBe(13);
    });

    it("marca estoqueZeradoEm somente quando um produto que JÁ TEVE estoque volta a zero", async () => {
      const produto = await service.criar(payloadProduto("Q"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      // ainda sem estoque: recém-criado, nunca teve → não deve marcar.
      expect((await service.obterPorId(produto.id)).estoqueZeradoEm).toBeNull();

      const comEstoque = await service.adicionarTamanho(produto.id, String(variante._id), { tamanho: "U", quantidade: 5 }, null);
      expect((await service.obterPorId(produto.id)).estoqueZeradoEm).toBeNull();

      await service.ajustarQuantidadeTamanho(produto.id, String(variante._id), {
        tamanhoId: String(comEstoque.tamanhos[0]!._id),
        delta: -5,
        exigirExistente: true,
      });
      const zerado = await service.obterPorId(produto.id);
      expect(zerado.quantidadeTotal).toBe(0);
      expect(zerado.estoqueZeradoEm).not.toBeNull();
    });

    it("nunca permite estoque negativo", async () => {
      const produto = await service.criar(payloadProduto("R"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      const comTamanho = await service.adicionarTamanho(produto.id, String(variante._id), { tamanho: "M", quantidade: 2 }, null);
      const tamanhoId = String(comTamanho.tamanhos[0]!._id);

      await expect(
        service.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanhoId, delta: -3, exigirExistente: true }),
      ).rejects.toThrow(ApiException);
    });
  });

  describe("promoção", () => {
    it("ativa a promoção e recalcula a margem sobre o preço promocional", async () => {
      const produto = await service.criar(payloadProduto("S", { precoCusto: 50, precoVenda: 100 }), null);
      const comPromocao = await service.definirPromocao(produto.id, { ehPromocao: true, precoPromocional: 80 }, null);
      expect(comPromocao.precoPromocional).toBe(80);
      expect(comPromocao.margemLucro).toBe(37.5); // (80-50)/80*100
    });

    it("rejeita preço promocional maior ou igual ao preço de venda", async () => {
      const produto = await service.criar(payloadProduto("T", { precoCusto: 50, precoVenda: 100 }), null);
      await expect(
        service.definirPromocao(produto.id, { ehPromocao: true, precoPromocional: 100 }, null),
      ).rejects.toThrow(ApiException);
    });

    // Etapa 18.7 — margem negativa é matematicamente válida (venda abaixo do
    // custo, ex.: liquidação de prejuízo) e não deve ser bloqueada nem
    // arredondada para zero: só o preço efetivo <= 0 devolve 0 (ver `precos.util.ts`).
    it("permite e calcula corretamente margem negativa (venda abaixo do custo)", async () => {
      const produto = await service.criar(payloadProduto("U", { precoCusto: 100, precoVenda: 50 }), null);
      expect(produto.margemLucro).toBe(-100); // (50-100)/50*100
    });
  });

  /**
   * Etapa 18.7 — prova de concorrência REAL (Promise.all/allSettled contra o
   * MongoDB de teste), não apenas descrição das estratégias já documentadas
   * no código (`SequenciasRepository.proximoValor` para o código sequencial,
   * `adicionarVarianteAtomico`/`$push` atômico para cor, `salvarComRetentativa`
   * com retry em `VersionError` para as demais mutações do documento).
   */
  describe("concorrência (Etapa 18.7)", () => {
    it("L/M. 15 criações concorrentes: todas succeed, todos os codProduto são distintos (nenhuma colisão)", async () => {
      const resultados = await Promise.allSettled(
        Array.from({ length: 15 }, (_, indice) => service.criar(payloadProduto(`CONC-${indice}`), null)),
      );
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

      const codigos = resultados
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.criar>>> => r.status === "fulfilled")
        .map((r) => r.value.codProduto);
      expect(new Set(codigos).size).toBe(15); // nenhum código repetido sob concorrência real
    });

    it("variantes com cores DIFERENTES adicionadas concorrentemente ao MESMO produto: todas persistem, quantidadeTotal nunca perde escrita", async () => {
      const produto = await service.criar(payloadProduto("CONC-VAR"), null);
      const cores = ["Preto", "Branco", "Azul", "Verde", "Vermelho", "Amarelo"];

      const resultados = await Promise.allSettled(cores.map((cor) => service.adicionarVariante(produto.id, { cor }, null)));
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

      const final = await service.obterPorId(produto.id);
      expect(final.variantes).toHaveLength(cores.length); // nenhuma variante perdida por escrita concorrente
      expect(new Set(final.variantes.map((v) => v.corNormalizada)).size).toBe(cores.length);
    });

    it("variantes com a MESMA cor adicionadas concorrentemente ao mesmo produto: só UMA vence, as demais são rejeitadas (nunca duplicam)", async () => {
      const produto = await service.criar(payloadProduto("CONC-VAR-DUP"), null);

      const resultados = await Promise.allSettled(
        Array.from({ length: 5 }, () => service.adicionarVariante(produto.id, { cor: "Preto" }, null)),
      );
      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      const falha = resultados.filter((r) => r.status === "rejected");
      expect(sucesso).toHaveLength(1);
      expect(falha).toHaveLength(4);

      const final = await service.obterPorId(produto.id);
      expect(final.variantes.filter((v) => v.corNormalizada === "preto")).toHaveLength(1);
    });

    it("dois tamanhos DIFERENTES adicionados concorrentemente à MESMA variante: ambos persistem via retry de salvarComRetentativa (nenhum lost update)", async () => {
      const produto = await service.criar(payloadProduto("CONC-TAM"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);

      const resultados = await Promise.allSettled([
        service.adicionarTamanho(produto.id, String(variante._id), { tamanho: "P", quantidade: 5 }, null),
        service.adicionarTamanho(produto.id, String(variante._id), { tamanho: "M", quantidade: 7 }, null),
      ]);
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true); // sem VersionError vazando ao chamador

      const final = await service.obterPorId(produto.id);
      const varFinal = final.variantes.find((v) => String(v._id) === String(variante._id))!;
      expect(varFinal.tamanhos).toHaveLength(2); // os dois tamanhos sobreviveram, nenhum sobrescrito
      expect(varFinal.quantidadeVariante).toBe(12); // 5 + 7 — derivado corretamente após o retry
      expect(final.quantidadeTotal).toBe(12);
    });

    it("duas atualizações concorrentes do MESMO produto: ambas succeed via retry otimista, documento final consistente", async () => {
      const produto = await service.criar(payloadProduto("CONC-UPD", { precoCusto: 50, precoVenda: 100 }), null);
      const dtoBase = { nome: produto.nome, categoria: produto.categoria, precoCusto: 50, ehNovidade: false };

      const resultados = await Promise.allSettled([
        service.atualizar(produto.id, { ...dtoBase, precoVenda: 120 }, null),
        service.atualizar(produto.id, { ...dtoBase, precoVenda: 150 }, null),
      ]);
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true); // retry absorve o VersionError, nunca propaga 409 ao chamador

      const final = await service.obterPorId(produto.id);
      expect([120, 150]).toContain(final.precoVenda); // uma das duas escritas venceu por último — nunca um valor corrompido/misturado
      expect(final.margemLucro).toBe(calcularMargemEsperada(50, final.precoVenda));
    });
  });
});

function calcularMargemEsperada(custo: number, precoEfetivoValor: number): number {
  return Number((((precoEfetivoValor - custo) / precoEfetivoValor) * 100).toFixed(2));
}
