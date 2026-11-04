import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Error as MongooseErrors, Types, type Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { liberarTudo, novoPonto, type PontoDeParada } from "../../test-utils/barreira.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { CampanhasService } from "../campanhas/campanhas.service.js";
import { ColecoesService } from "../colecoes/colecoes.service.js";
import { ConfiguracoesService } from "../configuracoes/configuracoes.service.js";
import { FornecedoresService } from "../fornecedores/fornecedores.service.js";
import type { CriarProdutoDto } from "./dto/criar-produto.dto.js";
import { ProdutosModule } from "./produtos.module.js";
import { ProdutosRepository } from "./produtos.repository.js";
import { ProdutosService } from "./produtos.service.js";
import type { Sequencia } from "../sequencias/schemas/sequencia.schema.js";
import type { Configuracao } from "../configuracoes/schemas/configuracao.schema.js";

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
  let configuracoesService: ConfiguracoesService;
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
    configuracoesService = moduleRef.get(ConfiguracoesService);
    connection = moduleRef.get(getConnectionToken());
    // Fase 54.2 — pré-requisito para `adicionarVariante`/`atualizarVariante`/
    // `adicionarTamanho`: todos os valores usados neste arquivo precisam
    // existir em `configuracoes.cores`/`tamanhos` ("!!!"/"###" não — falham
    // antes, na validação de formato).
    for (const cor of ["Branco", "Preto", "Verde", "Azul", "Vermelho", "Amarelo", "Azul Marinho", "Rosé"]) {
      await garantirItemConfiguracao(configuracoesService, "cores", cor);
    }
    for (const tamanho of ["M", "P", "U"]) {
      await garantirItemConfiguracao(configuracoesService, "tamanhos", tamanho);
    }
    // Fase 55.1 — mesmo pré-requisito, agora para `criar`/`atualizar` (categoria).
    for (const categoria of ["Vestidos", "Calças"]) {
      await garantirItemConfiguracao(configuracoesService, "categorias", categoria);
    }
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("fornecedores").deleteMany({});
    await connection.collection("eventos_fornecedor").deleteMany({});
    await connection.collection("colecoes").deleteMany({});
    await connection.collection("eventos_colecao").deleteMany({});
    await connection.collection("campanhas").deleteMany({});
    await connection.collection("eventos_campanha").deleteMany({});
    await connection.collection<Configuracao>("configuracoes").deleteMany({});
    await connection.collection("eventos_configuracao").deleteMany({});
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

    it("calcula a margem sobre o preço de custo na criação", async () => {
      const produto = await service.criar(payloadProduto("C", { precoCusto: 50, precoVenda: 100 }), null);
      expect(produto.margemLucro).toBe(100); // (100-50)/50*100
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
      expect(atualizado.margemLucro).toBe(100); // (120-60)/60*100
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
      expect(comPromocao.margemLucro).toBe(60); // (80-50)/50*100
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
      expect(produto.margemLucro).toBe(-50); // (50-100)/100*100
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

  describe("validação de cor/tamanho contra configuracoes (Fase 54.2)", () => {
    it("cria variante com cor existente nas configurações", async () => {
      const produto = await service.criar(payloadProduto("V54-1"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      expect(variante.cor).toBe("Preto");
    });

    it("rejeita criar variante com cor inexistente nas configurações, com a mensagem de negócio exata", async () => {
      const produto = await service.criar(payloadProduto("V54-2"), null);
      const corInexistente = `CorNuncaCadastrada-${Date.now()}`;
      await expect(service.adicionarVariante(produto.id, { cor: corInexistente }, null)).rejects.toThrow(
        "Esta cor não está cadastrada nas configurações da loja. Cadastre a cor antes de utilizá-la em um produto.",
      );
    });

    it("reconhece variações de maiúsculas/minúsculas da mesma cor cadastrada", async () => {
      const produto = await service.criar(payloadProduto("V54-3"), null);
      // "preto" (minúsculas) deve ser aceito porque "Preto" já está cadastrado.
      const variante = await service.adicionarVariante(produto.id, { cor: "preto" }, null);
      expect(variante.cor).toBe("preto"); // apresentação original preservada, não reescrita para "Preto"
    });

    it("altera variante para outra cor existente nas configurações", async () => {
      const produto = await service.criar(payloadProduto("V54-4"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      const atualizada = await service.atualizarVariante(produto.id, String(variante._id), { cor: "Verde" }, null);
      expect(atualizada.cor).toBe("Verde");
    });

    it("rejeita alterar variante para cor inexistente nas configurações, sem modificar a variante", async () => {
      const produto = await service.criar(payloadProduto("V54-5"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      const corInexistente = `CorNuncaCadastrada-${Date.now()}`;

      await expect(
        service.atualizarVariante(produto.id, String(variante._id), { cor: corInexistente }, null),
      ).rejects.toThrow("Esta cor não está cadastrada nas configurações da loja. Cadastre a cor antes de utilizá-la em um produto.");

      const produtoFinal = await service.obterPorId(produto.id);
      const varianteFinal = produtoFinal.variantes.find((item) => String(item._id) === String(variante._id))!;
      expect(varianteFinal.cor).toBe("Preto"); // nada foi alterado
    });

    it("alterar uma variante SEM mudar sua cor nunca valida contra configuracoes (evita erro por dado histórico)", async () => {
      const produto = await service.criar(payloadProduto("V54-6"), null);
      const corHistorica = `CorHistoricaNuncaMaisCadastrada-${Date.now()}`;
      await configuracoesService.adicionarItem("cores", corHistorica, null);
      const variante = await service.adicionarVariante(produto.id, { cor: corHistorica }, null);
      // Simula dado histórico: a cor deixou de existir em `configuracoes.cores`
      // por algum outro meio que não `removerItem` (a proteção de exclusão da
      // Fase 54.0 bloquearia a remoção normal enquanto a variante existir —
      // não é isso que este teste quer exercitar). Manipulação direta do
      // Mongo só para o SETUP do teste, nunca como fluxo de produção.
      await connection.collection<Configuracao>("configuracoes").updateOne({}, { $pull: { cores: corHistorica, coresNormalizadas: corHistorica.toLowerCase() } });

      // Editar só a foto, reenviando a MESMA cor (o DTO exige o campo) não
      // deve falhar mesmo com a cor já fora das configurações.
      const atualizada = await service.atualizarVariante(
        produto.id,
        String(variante._id),
        { cor: corHistorica, foto: "https://cdn.mariela.com/produtos/historico.jpg" },
        null,
      );
      expect(atualizada.cor).toBe(corHistorica);
      expect(atualizada.foto).toBe("https://cdn.mariela.com/produtos/historico.jpg");
    });

    it("cria tamanho com valor existente nas configurações", async () => {
      const produto = await service.criar(payloadProduto("V54-7"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      const atualizada = await service.adicionarTamanho(produto.id, String(variante._id), { tamanho: "M", quantidade: 1 }, null);
      expect(atualizada.tamanhos.some((t) => t.tamanho === "M")).toBe(true);
    });

    it("rejeita adicionar tamanho inexistente nas configurações, com a mensagem de negócio exata, sem modificar a variante", async () => {
      const produto = await service.criar(payloadProduto("V54-8"), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      const tamanhoInexistente = `XGG-${Date.now()}`;

      await expect(
        service.adicionarTamanho(produto.id, String(variante._id), { tamanho: tamanhoInexistente, quantidade: 1 }, null),
      ).rejects.toThrow("Este tamanho não está cadastrado nas configurações da loja. Cadastre o tamanho antes de utilizá-lo em um produto.");

      const produtoFinal = await service.obterPorId(produto.id);
      const varianteFinal = produtoFinal.variantes.find((item) => String(item._id) === String(variante._id))!;
      expect(varianteFinal.tamanhos).toHaveLength(0);
    });

    it("reconhece variações de caixa e espaços do mesmo tamanho cadastrado ('p' e ' p ' reconhecidos como 'P')", async () => {
      const produto1 = await service.criar(payloadProduto("V54-9A"), null);
      const variante1 = await service.adicionarVariante(produto1.id, { cor: "Preto" }, null);
      const atualizada1 = await service.adicionarTamanho(produto1.id, String(variante1._id), { tamanho: "p", quantidade: 1 }, null);
      expect(atualizada1.tamanhos.some((t) => t.tamanho === "P")).toBe(true); // normalizarTamanho já uppercase

      const produto2 = await service.criar(payloadProduto("V54-9B"), null);
      const variante2 = await service.adicionarVariante(produto2.id, { cor: "Preto" }, null);
      const atualizada2 = await service.adicionarTamanho(produto2.id, String(variante2._id), { tamanho: "  p  ", quantidade: 1 }, null);
      expect(atualizada2.tamanhos.some((t) => t.tamanho === "P")).toBe(true);
    });

    it("editar a descrição do produto não exige revalidar cor/tamanho de nenhuma variante existente", async () => {
      const produto = await service.criar(payloadProduto("V54-10"), null);
      await service.adicionarVariante(produto.id, { cor: "Preto" }, null);

      const atualizado = await service.atualizar(
        produto.id,
        { nome: produto.nome, descricao: "Nova descrição, sem relação com cor/tamanho", categoria: produto.categoria, precoCusto: 50, precoVenda: 100, ehNovidade: false },
        null,
      );
      expect(atualizado.descricao).toBe("Nova descrição, sem relação com cor/tamanho");
    });

    it("uma falha de validação de cor/tamanho nunca cria efeito parcial no produto", async () => {
      const produto = await service.criar(payloadProduto("V54-11"), null);
      const antes = await service.obterPorId(produto.id);
      expect(antes.variantes).toHaveLength(0);

      await expect(service.adicionarVariante(produto.id, { cor: `Inexistente-${Date.now()}` }, null)).rejects.toThrow(ApiException);

      const depois = await service.obterPorId(produto.id);
      expect(depois.variantes).toHaveLength(0); // nenhuma variante parcial foi criada
      expect(depois.quantidadeTotal).toBe(0);
    });
  });

  describe("validação de categoria contra configuracoes (Fase 55.1)", () => {
    it("cria produto com categoria existente nas configurações", async () => {
      const produto = await service.criar(payloadProduto("CAT-1"), null);
      expect(produto.categoria).toBe("Vestidos");
    });

    it("rejeita criar produto com categoria inexistente nas configurações, com a mensagem de negócio exata", async () => {
      const categoriaInexistente = `CategoriaNuncaCadastrada-${Date.now()}`;
      await expect(service.criar(payloadProduto("CAT-2", { categoria: categoriaInexistente }), null)).rejects.toThrow(
        "Esta categoria não está cadastrada nas configurações da loja. Cadastre a categoria antes de utilizá-la em um produto.",
      );
    });

    it("rejeita categoria com variação de escrita que NÃO corresponde a nenhuma categoria cadastrada (não é só normalização)", async () => {
      // "Vestido" (singular) é uma PALAVRA DIFERENTE de "Vestidos" (plural) depois
      // de normalizada — não deve ser aceita só porque é parecida/compartilha prefixo.
      await expect(service.criar(payloadProduto("CAT-3", { categoria: "Vestido" }), null)).rejects.toThrow(
        "Esta categoria não está cadastrada nas configurações da loja. Cadastre a categoria antes de utilizá-la em um produto.",
      );
    });

    it("reconhece variações de maiúsculas/minúsculas/acentos/espaços da mesma categoria cadastrada", async () => {
      const produto = await service.criar(payloadProduto("CAT-4", { categoria: "  VESTIDOS  " }), null);
      expect(produto.categoria).toBe("VESTIDOS"); // apresentação original preservada (só trim), não reescrita para "Vestidos"
    });

    it("altera produto para outra categoria existente nas configurações", async () => {
      const produto = await service.criar(payloadProduto("CAT-5"), null);
      const atualizado = await service.atualizar(
        produto.id,
        { nome: produto.nome, descricao: "", categoria: "Calças", precoCusto: 50, precoVenda: 100, ehNovidade: false },
        null,
      );
      expect(atualizado.categoria).toBe("Calças");
    });

    it("rejeita alterar produto para categoria inexistente nas configurações, sem modificar o produto", async () => {
      const produto = await service.criar(payloadProduto("CAT-6"), null);
      const categoriaInexistente = `CategoriaNuncaCadastrada-${Date.now()}`;

      await expect(
        service.atualizar(
          produto.id,
          { nome: produto.nome, descricao: "", categoria: categoriaInexistente, precoCusto: 50, precoVenda: 100, ehNovidade: false },
          null,
        ),
      ).rejects.toThrow("Esta categoria não está cadastrada nas configurações da loja. Cadastre a categoria antes de utilizá-la em um produto.");

      const produtoFinal = await service.obterPorId(produto.id);
      expect(produtoFinal.categoria).toBe("Vestidos"); // nada foi alterado
    });

    it("alterar um produto SEM mudar sua categoria nunca valida contra configuracoes (evita erro por dado histórico)", async () => {
      const categoriaHistorica = `CategoriaHistoricaNuncaMaisCadastrada-${Date.now()}`;
      await configuracoesService.adicionarItem("categorias", categoriaHistorica, null);
      const produto = await service.criar(payloadProduto("CAT-7", { categoria: categoriaHistorica }), null);
      // Simula dado histórico: a categoria deixou de existir em
      // `configuracoes.categorias` por algum outro meio que não `removerItem`
      // (a proteção de exclusão da Fase 55.1 bloquearia a remoção normal
      // enquanto o produto existir — não é isso que este teste quer
      // exercitar). Manipulação direta do Mongo só para o SETUP do teste.
      await connection
        .collection<Configuracao>("configuracoes")
        .updateOne({}, { $pull: { categorias: categoriaHistorica, categoriasNormalizadas: categoriaHistorica.toLowerCase() } });

      // Editar só a descrição, reenviando a MESMA categoria (o DTO exige o
      // campo) não deve falhar mesmo com a categoria já fora das configurações.
      const atualizado = await service.atualizar(
        produto.id,
        { nome: produto.nome, descricao: "Nova descrição, sem relação com categoria", categoria: categoriaHistorica, precoCusto: 50, precoVenda: 100, ehNovidade: false },
        null,
      );
      expect(atualizado.categoria).toBe(categoriaHistorica);
      expect(atualizado.descricao).toBe("Nova descrição, sem relação com categoria");
    });

    it("comparação normalizada identifica mudança efetiva: reenviar a mesma categoria com grafia diferente não revalida", async () => {
      const categoriaHistorica = `HistoricaGrafiaDiferente-${Date.now()}`;
      await configuracoesService.adicionarItem("categorias", categoriaHistorica, null);
      const produto = await service.criar(payloadProduto("CAT-8", { categoria: categoriaHistorica }), null);
      await connection
        .collection<Configuracao>("configuracoes")
        .updateOne({}, { $pull: { categorias: categoriaHistorica, categoriasNormalizadas: categoriaHistorica.toLowerCase() } });

      // Mesma categoria, só com espaços/caixa diferentes — normaliza para o
      // MESMO valor já salvo, então não é uma mudança efetiva: não revalida.
      const atualizado = await service.atualizar(
        produto.id,
        { nome: produto.nome, descricao: "", categoria: `  ${categoriaHistorica.toUpperCase()}  `, precoCusto: 50, precoVenda: 100, ehNovidade: false },
        null,
      );
      expect(atualizado.categoria).toBe(categoriaHistorica.toUpperCase());
    });

    it("uma falha de validação de categoria nunca cria efeito parcial (produto não é criado)", async () => {
      const categoriaInexistente = `CategoriaInexistente-${Date.now()}`;
      await expect(service.criar(payloadProduto("CAT-9", { categoria: categoriaInexistente }), null)).rejects.toThrow(ApiException);

      const total = await connection.collection("produtos").countDocuments({ nome: /^Vestido Teste CAT-9$/ });
      expect(total).toBe(0);
    });

    it("preserva o contrato de resposta existente de criar/atualizar produto (campo 'categoria' continua string simples)", async () => {
      const produto = await service.criar(payloadProduto("CAT-10"), null);
      expect(typeof produto.categoria).toBe("string");
      expect((produto as unknown as { categoriaNormalizada?: unknown }).categoriaNormalizada).toBeUndefined();

      const atualizado = await service.atualizar(
        produto.id,
        { nome: produto.nome, descricao: "", categoria: "Calças", precoCusto: 50, precoVenda: 100, ehNovidade: false },
        null,
      );
      expect(typeof atualizado.categoria).toBe("string");
      expect((atualizado as unknown as { categoriaNormalizada?: unknown }).categoriaNormalizada).toBeUndefined();
    });
  });

  /**
   * Fase 56.3 — integridade da variante (mesmo documento de produto).
   *
   * `adicionarTamanho`/`atualizarVariante`/`ajustarQuantidadeTamanho` usam
   * `ProdutosRepository.salvarComRetentativa`: lê o produto → aplica `mutar`
   * (onde ficam as regras de tamanho duplicado e do tamanho único `U`) → `save()`
   * com controle otimista (`optimisticConcurrency`, `__v`). Se outra operação
   * salvou no meio, `save()` rejeita com `VersionError` e tudo é refeito sobre
   * o documento NOVO — as regras são reavaliadas com o estado real. Até 3
   * tentativas.
   *
   * Barreira determinística: um spy em `encontrarPorIdOuFalhar` (chamado por
   * `salvarComRetentativa` na mesma instância) pausa a operação A logo DEPOIS
   * da leitura e ANTES do `save()`; a operação B roda inteira nesse intervalo.
   * A contagem de leituras prova que A foi refeita (VersionError exercitado).
   */
  describe("integridade da variante sob concorrência determinística (Fase 56.3)", () => {
    type Resultado = { ok: true } | { ok: false; erro: unknown };

    async function produtoComVariante(sufixo: string): Promise<{ produtoId: string; varianteId: string }> {
      const produto = await service.criar(payloadProduto(`TAM-${sufixo}`), null);
      const variante = await service.adicionarVariante(produto.id, { cor: "Preto" }, null);
      return { produtoId: produto.id, varianteId: String(variante._id) };
    }

    /** Pausa a N-ésima leitura de produto (índices em `pausas`), depois de ler e antes de devolver o documento. */
    function pausarLeiturasDeProduto(pausas: Map<number, PontoDeParada>) {
      const original = produtosRepository.encontrarPorIdOuFalhar.bind(produtosRepository);
      let leituras = 0;
      const espiao = spyOn(produtosRepository, "encontrarPorIdOuFalhar").mockImplementation(async (id) => {
        leituras += 1;
        const produto = await original(id);
        const ponto = pausas.get(leituras);
        if (ponto) {
          ponto.chegou.liberar();
          await ponto.liberacao.promessa;
        }
        return produto;
      });
      return { espiao, leituras: () => leituras };
    }

    function capturar(operacao: Promise<unknown>): Promise<Resultado> {
      return operacao.then(
        (): Resultado => ({ ok: true }),
        (erro: unknown): Resultado => ({ ok: false, erro }),
      );
    }

    /** A lê e para antes de salvar; B roda inteira; A é liberada (VersionError → releitura → regras reavaliadas). */
    async function corrida(operacaoA: () => Promise<unknown>, operacaoB: () => Promise<unknown>) {
      const pausaA = novoPonto();
      const { espiao, leituras } = pausarLeiturasDeProduto(new Map([[1, pausaA]]));
      try {
        const resultadoA = capturar(operacaoA());
        await pausaA.chegou.promessa; // A já leu (versão antiga) e está parada antes do save()
        await operacaoB(); // B lê, aplica e salva: a versão avança
        pausaA.liberacao.liberar();
        return { a: await resultadoA, leituras: leituras() };
      } finally {
        liberarTudo(pausaA);
        espiao.mockRestore();
      }
    }

    /** Formato persistido (lido direto da coleção, sem hidratar pelo Mongoose). */
    type ProdutoPersistido = {
      _id: Types.ObjectId;
      variantes: { _id: Types.ObjectId; foto: string | null; quantidadeVariante: number; tamanhos: { tamanho: string; quantidade: number }[] }[];
    };

    async function varianteNoBanco(produtoId: string, varianteId: string) {
      const produto = await connection.collection<ProdutoPersistido>("produtos").findOne({ _id: new Types.ObjectId(produtoId) });
      return (produto?.variantes ?? []).find((variante) => String(variante._id) === varianteId);
    }

    function erroDe(resultado: Resultado): unknown {
      return resultado.ok ? null : resultado.erro;
    }

    describe("regra do tamanho único (U) — persistência", () => {
      it("U em variante vazia é aceito e persistido como 'U' (inclusive a partir de 'u')", async () => {
        const { produtoId, varianteId } = await produtoComVariante("U-VAZIA");
        await service.adicionarTamanho(produtoId, varianteId, { tamanho: "u", quantidade: 2 }, null);
        expect((await varianteNoBanco(produtoId, varianteId))?.tamanhos.map((item) => item.tamanho)).toEqual(["U"]);
      });

      it("com U na variante, outro tamanho é rejeitado e a variante continua só com U no banco", async () => {
        const { produtoId, varianteId } = await produtoComVariante("U-PRIMEIRO");
        await service.adicionarTamanho(produtoId, varianteId, { tamanho: "U", quantidade: 2 }, null);
        await expect(service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 1 }, null)).rejects.toMatchObject({
          errors: [{ field: "tamanho", message: "Esta variante usa tamanho único (U): não é possível adicionar outros tamanhos." }],
        });
        expect((await varianteNoBanco(produtoId, varianteId))?.tamanhos.map((item) => item.tamanho)).toEqual(["U"]);
      });

      it("com outro tamanho na variante, U é rejeitado e a variante continua só com ele no banco", async () => {
        const { produtoId, varianteId } = await produtoComVariante("P-PRIMEIRO");
        await service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 2 }, null);
        await expect(service.adicionarTamanho(produtoId, varianteId, { tamanho: "U", quantidade: 1 }, null)).rejects.toMatchObject({
          errors: [{ field: "tamanho", message: "Esta variante já possui tamanhos: o tamanho único (U) não pode coexistir com outros." }],
        });
        expect((await varianteNoBanco(produtoId, varianteId))?.tamanhos.map((item) => item.tamanho)).toEqual(["P"]);
      });

      it("entrada de estoque criando um tamanho novo numa variante com U também respeita a regra", async () => {
        const { produtoId, varianteId } = await produtoComVariante("U-ESTOQUE");
        await service.adicionarTamanho(produtoId, varianteId, { tamanho: "U", quantidade: 1 }, null);
        await expect(
          service.ajustarQuantidadeTamanho(produtoId, varianteId, { tamanho: "M", delta: 3, exigirExistente: false, exigirTamanhoCadastrado: true }),
        ).rejects.toMatchObject({ errors: [{ field: "tamanho", message: "Esta variante usa tamanho único (U): não é possível adicionar outros tamanhos." }] });
        expect((await varianteNoBanco(produtoId, varianteId))?.tamanhos.map((item) => item.tamanho)).toEqual(["U"]);
      });
    });

    describe("garantias (controle otimista, entrelaçamento determinístico)", () => {
      it("tamanhos DISTINTOS na mesma variante: A é refeita após o VersionError e os dois persistem", async () => {
        const { produtoId, varianteId } = await produtoComVariante("CONC-DIST");
        const { a, leituras } = await corrida(
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 5 }, null),
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "M", quantidade: 7 }, null),
        );
        expect(a.ok).toBe(true);
        expect(leituras).toBe(3); // A leu, B leu, A releu após o VersionError
        const variante = await varianteNoBanco(produtoId, varianteId);
        expect(variante?.tamanhos.map((item) => item.tamanho).sort()).toEqual(["M", "P"]);
        expect(variante?.quantidadeVariante).toBe(12);
      });

      it("MESMO tamanho (grafias equivalentes) na mesma variante: A, refeita sobre o documento novo, é rejeitada — nunca duplica", async () => {
        const { produtoId, varianteId } = await produtoComVariante("CONC-IGUAL");
        const { a, leituras } = await corrida(
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 5 }, null),
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: " p ", quantidade: 7 }, null),
        );
        expect(a.ok).toBe(false);
        expect(erroDe(a)).toBeInstanceOf(ApiException);
        expect(erroDe(a)).toMatchObject({ errors: [{ field: "tamanho", message: "Este tamanho já está cadastrado nesta variante." }] });
        expect(leituras).toBe(3);
        const variante = await varianteNoBanco(produtoId, varianteId);
        expect(variante?.tamanhos.map(({ tamanho, quantidade }) => ({ tamanho, quantidade }))).toEqual([{ tamanho: "P", quantidade: 7 }]);
      });

      it("U × tamanho convencional: A (U) é refeita, vê o P gravado por B e é rejeitada pela regra do tamanho único", async () => {
        const { produtoId, varianteId } = await produtoComVariante("CONC-U-P");
        const { a, leituras } = await corrida(
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "U", quantidade: 1 }, null),
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 2 }, null),
        );
        expect(a.ok).toBe(false);
        expect(erroDe(a)).toBeInstanceOf(ApiException);
        expect(erroDe(a)).toMatchObject({
          errors: [{ field: "tamanho", message: "Esta variante já possui tamanhos: o tamanho único (U) não pode coexistir com outros." }],
        });
        expect(leituras).toBe(3);
        expect((await varianteNoBanco(produtoId, varianteId))?.tamanhos.map((item) => item.tamanho)).toEqual(["P"]);
      });

      it("tamanho convencional × U: A (P) é refeita, vê o U gravado por B e é rejeitada pela regra do tamanho único", async () => {
        const { produtoId, varianteId } = await produtoComVariante("CONC-P-U");
        const { a, leituras } = await corrida(
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 2 }, null),
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "U", quantidade: 1 }, null),
        );
        expect(a.ok).toBe(false);
        expect(erroDe(a)).toBeInstanceOf(ApiException);
        expect(erroDe(a)).toMatchObject({ errors: [{ field: "tamanho", message: "Esta variante usa tamanho único (U): não é possível adicionar outros tamanhos." }] });
        expect(leituras).toBe(3);
        expect((await varianteNoBanco(produtoId, varianteId))?.tamanhos.map((item) => item.tamanho)).toEqual(["U"]);
      });

      it("grafias equivalentes de U ('u' × ' U '): só uma persiste, a outra é rejeitada como duplicada", async () => {
        const { produtoId, varianteId } = await produtoComVariante("CONC-U-U");
        const { a, leituras } = await corrida(
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "u", quantidade: 1 }, null),
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: " U ", quantidade: 3 }, null),
        );
        expect(a.ok).toBe(false);
        expect(erroDe(a)).toBeInstanceOf(ApiException);
        expect(erroDe(a)).toMatchObject({ errors: [{ field: "tamanho", message: "Este tamanho já está cadastrado nesta variante." }] });
        expect(leituras).toBe(3);
        expect((await varianteNoBanco(produtoId, varianteId))?.tamanhos.map(({ tamanho, quantidade }) => ({ tamanho, quantidade }))).toEqual([
          { tamanho: "U", quantidade: 3 },
        ]);
      });

      it("atualizar a variante (foto) × adicionar tamanho: nenhuma das duas escritas se perde", async () => {
        const { produtoId, varianteId } = await produtoComVariante("CONC-FOTO");
        const { a, leituras } = await corrida(
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "M", quantidade: 4 }, null),
          () => service.atualizarVariante(produtoId, varianteId, { cor: "Preto", foto: "https://exemplo.com/foto-concorrente.jpg" }, null),
        );
        expect(a.ok).toBe(true);
        expect(leituras).toBe(4); // A leu; B leu (validação) e leu de novo (salvarComRetentativa); A releu
        const variante = await varianteNoBanco(produtoId, varianteId);
        expect(variante?.foto).toBe("https://exemplo.com/foto-concorrente.jpg");
        expect(variante?.tamanhos.map((item) => item.tamanho)).toEqual(["M"]);
      });
    });

    /**
     * Fase 56.3.1 — esgotamento das 3 tentativas de `salvarComRetentativa`.
     * Antes (Fase 56.3), a 3ª `VersionError` era relançada crua e o filtro
     * global a devolvia como HTTP 500. Agora termina com
     * `ApiException.conflict` (HTTP 409, `code: "CONFLICT"`). O limite de 3
     * tentativas e a reavaliação das regras a cada tentativa não mudaram.
     *
     * `forcarConflitos(n)` pausa cada tentativa de A logo depois da leitura e,
     * nesse intervalo, faz uma escrita concorrente REAL (`ajustarQuantidadeTamanho`
     * no tamanho M, exatamente 1 leitura) — então as `n` primeiras tentativas
     * de A perdem a corrida de versão. Tentativas de A = leituras − n.
     */
    describe("esgotamento de retentativas (Fase 56.3.1)", () => {
      const MENSAGEM_CONFLITO = "Não foi possível salvar as alterações: o produto foi modificado por outra operação simultânea. Tente novamente.";

      /** Variante com o tamanho M (quantidade 1), usado pelas escritas concorrentes. */
      async function varianteComTamanhoM(sufixo: string) {
        const { produtoId, varianteId } = await produtoComVariante(sufixo);
        const variante = await service.adicionarTamanho(produtoId, varianteId, { tamanho: "M", quantidade: 1 }, null);
        return { produtoId, varianteId, tamanhoMId: String(variante.tamanhos[0]!._id) };
      }

      async function forcarConflitos(
        conflitos: number,
        operacaoA: () => Promise<unknown>,
        escritaConcorrente: (indice: number) => Promise<unknown>,
      ): Promise<{ a: Resultado; tentativasDeA: number }> {
        const pausas = Array.from({ length: conflitos }, () => novoPonto());
        // A tentativa k de A é a leitura 2k−1 (entre duas tentativas de A há exatamente 1 leitura concorrente).
        const { espiao, leituras } = pausarLeiturasDeProduto(new Map(pausas.map((pausa, indice) => [2 * indice + 1, pausa])));
        try {
          const resultadoA = capturar(operacaoA());
          for (const [indice, pausa] of pausas.entries()) {
            await pausa.chegou.promessa; // A leu e está parada antes do save()
            await escritaConcorrente(indice); // a versão avança: o save() de A vai falhar
            pausa.liberacao.liberar();
          }
          const a = await resultadoA;
          return { a, tentativasDeA: leituras() - conflitos };
        } finally {
          liberarTudo(...pausas);
          espiao.mockRestore();
        }
      }

      async function tamanhosPersistidos(produtoId: string, varianteId: string) {
        return (await varianteNoBanco(produtoId, varianteId))?.tamanhos.map(({ tamanho, quantidade }) => ({ tamanho, quantidade })).sort((x, y) => x.tamanho.localeCompare(y.tamanho));
      }

      it("A. 1ª tentativa conflita, 2ª funciona: sucesso em exatamente 2 tentativas, estado correto", async () => {
        const { produtoId, varianteId, tamanhoMId } = await varianteComTamanhoM("ESG-A");
        const { a, tentativasDeA } = await forcarConflitos(
          1,
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 5 }, null),
          () => service.ajustarQuantidadeTamanho(produtoId, varianteId, { tamanhoId: tamanhoMId, delta: 1, exigirExistente: true }),
        );
        expect(a.ok).toBe(true);
        expect(tentativasDeA).toBe(2);
        expect(await tamanhosPersistidos(produtoId, varianteId)).toEqual([
          { tamanho: "M", quantidade: 2 },
          { tamanho: "P", quantidade: 5 },
        ]);
      });

      it("B. 1ª e 2ª tentativas conflitam, 3ª funciona: sucesso em exatamente 3 tentativas, estado correto", async () => {
        const { produtoId, varianteId, tamanhoMId } = await varianteComTamanhoM("ESG-B");
        const { a, tentativasDeA } = await forcarConflitos(
          2,
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 5 }, null),
          () => service.ajustarQuantidadeTamanho(produtoId, varianteId, { tamanhoId: tamanhoMId, delta: 1, exigirExistente: true }),
        );
        expect(a.ok).toBe(true);
        expect(tentativasDeA).toBe(3);
        expect(await tamanhosPersistidos(produtoId, varianteId)).toEqual([
          { tamanho: "M", quantidade: 3 },
          { tamanho: "P", quantidade: 5 },
        ]);
      });

      it("C. as 3 tentativas conflitam: termina com o conflito do contrato (409 CONFLICT), nunca o VersionError cru — sem gravação parcial", async () => {
        const { produtoId, varianteId, tamanhoMId } = await varianteComTamanhoM("ESG-C");
        const { a, tentativasDeA } = await forcarConflitos(
          3,
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 5 }, null),
          () => service.ajustarQuantidadeTamanho(produtoId, varianteId, { tamanhoId: tamanhoMId, delta: 1, exigirExistente: true }),
        );
        expect(a.ok).toBe(false);
        const erro = erroDe(a);
        expect(erro).not.toBeInstanceOf(MongooseErrors.VersionError);
        expect(erro).toBeInstanceOf(ApiException);
        // Exatamente o que o HttpExceptionFilter serializa para uma ApiException.
        expect(erro).toMatchObject({ code: "CONFLICT", message: MENSAGEM_CONFLITO, errors: [] });
        expect(erro instanceof ApiException ? erro.getStatus() : null).toBe(409);
        expect(tentativasDeA).toBe(3); // limite inalterado
        // Só as 3 escritas concorrentes entraram; o P de A nunca foi gravado.
        expect(await tamanhosPersistidos(produtoId, varianteId)).toEqual([{ tamanho: "M", quantidade: 4 }]);
      });

      it("D. erro que não é VersionError (validação do schema no save) não é convertido em 409 nem retentado", async () => {
        const { produtoId, varianteId } = await varianteComTamanhoM("ESG-D");
        const { espiao, leituras } = pausarLeiturasDeProduto(new Map());
        try {
          // `quantidade` negativa viola o `min: 0` do schema de tamanho → `ValidationError` no save().
          const a = await capturar(service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: -1 }, null));
          expect(a.ok).toBe(false);
          expect(erroDe(a)).toBeInstanceOf(MongooseErrors.ValidationError); // propagado como antes
          expect(erroDe(a)).not.toBeInstanceOf(ApiException);
          expect(leituras()).toBe(1); // sem retentativa
        } finally {
          espiao.mockRestore();
        }
        expect(await tamanhosPersistidos(produtoId, varianteId)).toEqual([{ tamanho: "M", quantidade: 1 }]);
      });

      it("E. após o conflito a regra do U é reavaliada sobre o documento novo: rejeição de negócio (400), não 409", async () => {
        const { produtoId, varianteId } = await produtoComVariante("ESG-E");
        const { a, tentativasDeA } = await forcarConflitos(
          1,
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "P", quantidade: 2 }, null),
          () => service.adicionarTamanho(produtoId, varianteId, { tamanho: "U", quantidade: 1 }, null),
        );
        expect(a.ok).toBe(false);
        const erro = erroDe(a);
        expect(erro).toBeInstanceOf(ApiException);
        expect(erro).toMatchObject({
          code: "VALIDATION_ERROR",
          errors: [{ field: "tamanho", message: "Esta variante usa tamanho único (U): não é possível adicionar outros tamanhos." }],
        });
        expect(erro instanceof ApiException ? erro.getStatus() : null).toBe(400);
        expect(tentativasDeA).toBe(2); // a 2ª tentativa releu, viu o U e parou na regra
        expect(await tamanhosPersistidos(produtoId, varianteId)).toEqual([{ tamanho: "U", quantidade: 1 }]);
      });
    });
  });
});

function calcularMargemEsperada(custo: number, precoEfetivoValor: number): number {
  return Number((((precoEfetivoValor - custo) / custo) * 100).toFixed(2));
}
