import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { CampanhasService } from "../campanhas/campanhas.service.js";
import { ColecoesService } from "../colecoes/colecoes.service.js";
import { FornecedoresService } from "../fornecedores/fornecedores.service.js";
import type { CriarProdutoDto } from "./dto/criar-produto.dto.js";
import { ProdutosModule } from "./produtos.module.js";
import { ProdutosRepository } from "./produtos.repository.js";
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
  let produtosRepository: ProdutosRepository;
  let fornecedoresService: FornecedoresService;
  let colecoesService: ColecoesService;
  let campanhasService: CampanhasService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, ProdutosModule],
    }).compile();
    service = moduleRef.get(ProdutosService);
    produtosRepository = moduleRef.get(ProdutosRepository);
    fornecedoresService = moduleRef.get(FornecedoresService);
    colecoesService = moduleRef.get(ColecoesService);
    campanhasService = moduleRef.get(CampanhasService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("sequencias").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("fornecedores").deleteMany({});
    await connection.collection("eventos_fornecedor").deleteMany({});
    await connection.collection("colecoes").deleteMany({});
    await connection.collection("eventos_colecao").deleteMany({});
    await connection.collection("campanhas").deleteMany({});
    await connection.collection("eventos_campanha").deleteMany({});
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

    it("Etapa 20.01A — paginado=false devolve TODOS os produtos que casam o filtro, sem truncar pelo limit", async () => {
      const marcador = `SemPaginacao ${Date.now()}`;
      const quantidade = 22;
      for (let indice = 0; indice < quantidade; indice += 1) {
        await service.criar(payloadProduto(`H${indice}`, { nome: `${marcador} ${indice}` }), null);
      }

      const resultado = await service.listar(
        {
          busca: marcador,
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
        },
        false,
      );

      expect(resultado.data).toHaveLength(quantidade);
      expect(resultado.meta.total).toBe(quantidade);
      expect(resultado.meta.limit).toBe(quantidade);
      expect(resultado.meta.totalPages).toBe(1);
    });

    it("Etapa 20.01A — paginado=true (default) continua truncando pelo limit informado", async () => {
      const marcador = `ComPaginacao ${Date.now()}`;
      for (let indice = 0; indice < 3; indice += 1) {
        await service.criar(payloadProduto(`I${indice}`, { nome: `${marcador} ${indice}` }), null);
      }

      const resultado = await service.listar({
        busca: marcador,
        ordenarPor: "nome",
        ordem: "asc",
        page: 1,
        limit: 2,
        categorias: [],
        colecoes: [],
        campanhas: [],
        fornecedores: [],
        estoque: [],
        promocao: [],
        novidade: [],
      });

      expect(resultado.data).toHaveLength(2);
      expect(resultado.meta.total).toBe(3);
      expect(resultado.meta.totalPages).toBe(2);
    });

    it("Fase 29B.2 — página além do total: data vazio, meta consistente, sem erro", async () => {
      const marcador = `AlemDoLimite ${Date.now()}`;
      for (let indice = 0; indice < 3; indice += 1) {
        await service.criar(payloadProduto(`J${indice}`, { nome: `${marcador} ${indice}` }), null);
      }

      const resultado = await service.listar({
        busca: marcador,
        ordenarPor: "nome",
        ordem: "asc",
        page: 999,
        limit: 20,
        categorias: [],
        colecoes: [],
        campanhas: [],
        fornecedores: [],
        estoque: [],
        promocao: [],
        novidade: [],
      });

      expect(resultado.data).toEqual([]);
      expect(resultado.meta.total).toBe(3);
      expect(resultado.meta.page).toBe(999);
      expect(resultado.meta.limit).toBe(20);
      expect(resultado.meta.totalPages).toBe(1);
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

    /**
     * Etapa 10.23 — correção 6.5: uma cor sem NENHUM caractere alfanumérico
     * (ex.: "!!!") gera `codVariante` vazio de segmento → cai para o
     * `codProduto` puro (`formatarCodigoVariante`). Uma SEGUNDA cor nessas
     * condições no MESMO produto (cores diferentes o bastante para passar na
     * checagem de `corNormalizada`, mas ambas sem alfanumérico) geraria dois
     * `codVariante` idênticos. Rejeitado aqui como erro de domínio (400)
     * ANTES de qualquer escrita — nunca dependendo de um duplicate-key do
     * Mongo (que, verificado empiricamente contra o MongoDB real abaixo,
     * nem sequer acontece: um índice único multikey não protege contra
     * duplicatas DENTRO do mesmo documento, só entre documentos diferentes).
     */
    it("rejeita cor sem nenhum caractere alfanumérico com erro de validação (400)", async () => {
      const produto = await service.criar(payloadProduto("SEM-ALFANUM"), null);
      await expect(service.adicionarVariante(produto.id, { cor: "!!!" }, null)).rejects.toThrow(ApiException);
      try {
        await service.adicionarVariante(produto.id, { cor: "###" }, null);
        throw new Error("Deveria ter lançado ApiException.");
      } catch (erro) {
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).getStatus()).toBe(400);
      }
      const atualizado = await service.obterPorId(produto.id);
      expect(atualizado.variantes).toHaveLength(0); // nenhuma variante inválida foi persistida
    });

    /**
     * Prova, contra o MongoDB real (não um teste artificial da
     * implementação), a causa raiz CORRIGIDA que motivou a validação acima:
     * contornando a validação de serviço (chamando o repository diretamente,
     * como o código fazia ANTES desta correção), duas cores sem alfanumérico
     * geram `codVariante` idênticos e o MongoDB os aceita SEM ERRO — o índice
     * único em `variantes.codVariante` não impede duplicatas dentro do MESMO
     * documento. Ou seja: sem a validação de entrada, o resultado não seria
     * um 500 (a premissa original da auditoria), e sim uma inconsistência de
     * dados SILENCIOSA — o que torna a validação de entrada a ÚNICA defesa
     * real, não uma camada redundante sobre uma proteção do banco.
     */
    it("sem a validação de entrada, o MongoDB aceitaria dois codVariante idênticos silenciosamente (prova da causa raiz real)", async () => {
      const produto = await service.criar(payloadProduto("SEM-VALIDACAO"), null);
      const primeira = await produtosRepository.adicionarVarianteAtomico(produto.id, {
        cor: "!!!",
        corNormalizada: "!!!",
        codVariante: produto.codProduto,
        quantidadeVariante: 0,
        foto: null,
        video: null,
        tamanhos: [],
      });
      expect(primeira).not.toBeNull();

      const segunda = await produtosRepository.adicionarVarianteAtomico(produto.id, {
        cor: "###",
        corNormalizada: "###", // diferente de "!!!" — passa pela checagem de corNormalizada
        codVariante: produto.codProduto, // MESMO codVariante da primeira
        quantidadeVariante: 0,
        foto: null,
        video: null,
        tamanhos: [],
      });
      expect(segunda).not.toBeNull(); // nenhum erro — confirma que o índice sozinho NÃO bastava
      expect(segunda!.variantes.filter((v) => v.codVariante === produto.codProduto)).toHaveLength(2); // dois SKUs idênticos, silenciosamente
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

    // Etapa 10.23 — correção 6.11.2: antes, desativar a promoção mantinha
    // `precoPromocional` com o valor antigo ("fantasma") no documento — sem
    // impacto funcional (precoEfetivo sempre checa `ehPromocao` primeiro, e
    // reativar exige um novo valor no DTO), mas um dado enganoso para quem
    // inspecionasse o documento diretamente.
    it("desativar a promoção zera precoPromocional (nunca mantém o valor antigo)", async () => {
      const produto = await service.criar(payloadProduto("V-PROMO", { precoCusto: 50, precoVenda: 100 }), null);
      await service.definirPromocao(produto.id, { ehPromocao: true, precoPromocional: 80 }, null);
      const desativada = await service.definirPromocao(produto.id, { ehPromocao: false }, null);
      expect(desativada.ehPromocao).toBe(false);
      expect(desativada.precoPromocional).toBeNull();
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

  /**
   * Etapa 10.23 — correção 6.10: antes, `criar()`/`atualizar()` aceitavam
   * QUALQUER string em `fornecedorId`/`colecaoId`/`campanhaId`, mesmo
   * apontando para um registro inexistente ou já soft-deleted — apesar da
   * regra espelhada já estabelecida ("não é possível excluir Fornecedor/
   * Coleção/Campanha com produtos vinculados") tornar essa garantia
   * ilusória sem o check no sentido inverso. Real contra MongoDB (cria e
   * exclui os registros de verdade), nunca um teste artificial da própria
   * implementação.
   */
  describe("integridade referencial de fornecedor/coleção/campanha (Etapa 10.23)", () => {
    it("cria produto normalmente quando fornecedor/coleção/campanha existem e estão ativos", async () => {
      const fornecedor = await fornecedoresService.criar({ nome: `Fornecedor Ref ${Date.now()}` }, null);
      const colecao = await colecoesService.criar(
        { nome: `Coleção Ref ${Date.now()}`, inicio: "2026-01-01", fim: "2026-03-01" },
        null,
      );
      const campanha = await campanhasService.criar(
        { nome: `Campanha Ref ${Date.now()}`, inicio: "2026-01-01", fim: "2026-03-01" },
        null,
      );

      const produto = await service.criar(
        payloadProduto("REF-OK", { fornecedorId: fornecedor.id, colecaoId: colecao.id, campanhaId: campanha.id }),
        null,
      );
      expect(produto.fornecedorId).toBe(fornecedor.id);
      expect(produto.colecaoId).toBe(colecao.id);
      expect(produto.campanhaId).toBe(campanha.id);
    });

    it("rejeita criação com fornecedorId inexistente", async () => {
      await expect(
        service.criar(payloadProduto("REF-FORN-INEXISTENTE", { fornecedorId: "65f1a2b3c4d5e6f7a8b9c0d1" }), null),
      ).rejects.toThrow(ApiException);
    });

    it("rejeita criação com colecaoId inexistente", async () => {
      await expect(
        service.criar(payloadProduto("REF-COL-INEXISTENTE", { colecaoId: "65f1a2b3c4d5e6f7a8b9c0d1" }), null),
      ).rejects.toThrow(ApiException);
    });

    it("rejeita criação com campanhaId inexistente", async () => {
      await expect(
        service.criar(payloadProduto("REF-CAMP-INEXISTENTE", { campanhaId: "65f1a2b3c4d5e6f7a8b9c0d1" }), null),
      ).rejects.toThrow(ApiException);
    });

    it("rejeita criação apontando para fornecedor JÁ soft-deleted", async () => {
      const fornecedor = await fornecedoresService.criar({ nome: `Fornecedor Excluído ${Date.now()}` }, null);
      await fornecedoresService.excluir(fornecedor.id, null);

      await expect(
        service.criar(payloadProduto("REF-FORN-EXCLUIDO", { fornecedorId: fornecedor.id }), null),
      ).rejects.toThrow(ApiException);
    });

    it("rejeita atualização apontando para coleção JÁ soft-deleted (regra vale também na edição, não só na criação)", async () => {
      const colecao = await colecoesService.criar(
        { nome: `Coleção Excluída ${Date.now()}`, inicio: "2026-01-01", fim: "2026-03-01" },
        null,
      );
      const produto = await service.criar(payloadProduto("REF-COL-ATUALIZAR"), null);
      await colecoesService.excluir(colecao.id, null);

      await expect(
        service.atualizar(
          produto.id,
          { nome: produto.nome, categoria: produto.categoria, precoCusto: 50, precoVenda: 100, ehNovidade: false, colecaoId: colecao.id },
          null,
        ),
      ).rejects.toThrow(ApiException);

      const inalterado = await service.obterPorId(produto.id);
      expect(inalterado.colecaoId).toBeNull(); // a atualização rejeitada não deixou nenhum efeito parcial
    });

    it("permite referenciar uma campanha INATIVA (ativo=false), mas não excluída — ativo≠excluído", async () => {
      const campanha = await campanhasService.criar(
        { nome: `Campanha Inativa ${Date.now()}`, inicio: "2026-01-01", fim: "2026-03-01", ativo: false },
        null,
      );
      const produto = await service.criar(payloadProduto("REF-CAMP-INATIVA", { campanhaId: campanha.id }), null);
      expect(produto.campanhaId).toBe(campanha.id);
    });

    it("continua aceitando produto SEM nenhuma referência (todas opcionais, comportamento inalterado)", async () => {
      const produto = await service.criar(payloadProduto("REF-NENHUMA"), null);
      expect(produto.fornecedorId).toBeNull();
      expect(produto.colecaoId).toBeNull();
      expect(produto.campanhaId).toBeNull();
    });
  });
});

function calcularMargemEsperada(custo: number, precoEfetivoValor: number): number {
  return Number((((precoEfetivoValor - custo) / precoEfetivoValor) * 100).toFixed(2));
}
