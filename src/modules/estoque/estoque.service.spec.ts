import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type ClientSession, type Connection, type Model } from "mongoose";
import { MovimentacaoEstoque, type MovimentacaoEstoqueDocument } from "./schemas/movimentacao-estoque.schema.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { inserirMidiaDiretamente } from "../../test-utils/media-storage-falso.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { ConfiguracoesService } from "../configuracoes/configuracoes.service.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { EstoqueModule } from "./estoque.module.js";
import { EstoqueService } from "./estoque.service.js";
import type { EntradaEstoqueDto } from "./dto/entrada-estoque.dto.js";
import type { SaidaEstoqueDto } from "./dto/saida-estoque.dto.js";
import type { Sequencia } from "../sequencias/schemas/sequencia.schema.js";

// `ProdutosController` (importado transitivamente via `EstoqueModule` →
// `ProdutosModule`) usa `@UseGuards(JwtAuthGuard)`, que injeta `JwtService` —
// só disponível globalmente via `AppModule` de verdade. Este teste foca no
// service, então basta um `JwtModule` local mínimo para o grafo de DI
// compilar (mesmo padrão de `produtos.service.spec.ts`).
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

let contador = 0;
function sufixo(): string {
  contador += 1;
  return String(contador);
}

describe("EstoqueService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: EstoqueService;
  let produtosService: ProdutosService;
  let configuracoesService: ConfiguracoesService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, EstoqueModule],
    }).compile();
    service = moduleRef.get(EstoqueService);
    produtosService = moduleRef.get(ProdutosService);
    configuracoesService = moduleRef.get(ConfiguracoesService);
    connection = moduleRef.get(getConnectionToken());
    // Fase 54.2 — pré-requisito para `produtosService.adicionarVariante`/`adicionarTamanho`/`service.entrada`.
    for (const cor of ["Preto", "Azul", "Vermelho", "Amarelo", "Rosa"]) {
      await garantirItemConfiguracao(configuracoesService, "cores", cor);
    }
    for (const tamanho of ["M", "G"]) {
      await garantirItemConfiguracao(configuracoesService, "tamanhos", tamanho);
    }
    // Fase 55.1 — pré-requisito para `produtosService.criar` (categoria passou a ser validada).
    await garantirItemConfiguracao(configuracoesService, "categorias", "Vestidos");
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("movimentacoes_estoque").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["produto"] } });
    await moduleRef.close();
  });

  async function criarProduto(extra: Partial<CriarProdutoDto> = {}) {
    const s = sufixo();
    const dto: CriarProdutoDto = {
      nome: `Produto Estoque ${s}`,
      categoria: "Vestidos",
      precoCusto: 50,
      precoVenda: 150,
      ehNovidade: false,
      ...extra,
    };
    return produtosService.criar(dto, null);
  }

  /** Produto com uma variante e um tamanho já cadastrado (quantidade inicial informada). */
  async function criarProdutoComTamanho(quantidadeInicial: number) {
    const produto = await criarProduto();
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Preto" }, null);
    const varianteAtualizada = await produtosService.adicionarTamanho(
      produto.id,
      String(variante._id),
      { tamanho: "M", quantidade: quantidadeInicial },
      null,
    );
    const tamanhoId = String(varianteAtualizada.tamanhos[0]!._id);
    return { produtoId: produto.id, varianteId: String(variante._id), tamanhoId };
  }

  /** `produtoId` é persistido como `ObjectId` no schema — a query direta via `Connection` (fora do Model) não faz o cast automático do Mongoose. */
  /**
   * Movimentações das OPERAÇÕES DE ESTOQUE sob teste. Fase 22.3 — o saldo inicial que `criarProdutoComTamanho` informa
   * no cadastro do tamanho passou a gerar uma entrada `origem: "cadastro"` (preparação, não a operação testada); ela fica
   * de fora aqui e é verificada pelos testes da Fase 22.3 abaixo.
   */
  async function movimentacoesDoProduto(produtoId: string) {
    return connection
      .collection("movimentacoes_estoque")
      .find({ produtoId: new Types.ObjectId(produtoId), origem: { $ne: "cadastro" } })
      .toArray();
  }

  describe("entrada", () => {
    it("aumenta a quantidade de um tamanho existente e atualiza os derivados", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(5);
      const dto: EntradaEstoqueDto = { produtoId, varianteId, tamanhoId, quantidade: 3 };

      const produto = await service.entrada(dto, null);
      const variante = produto.variantes.find((item) => String(item._id) === varianteId)!;
      const tamanho = variante.tamanhos.find((item) => String(item._id) === tamanhoId)!;
      expect(tamanho.quantidade).toBe(8);
      expect(variante.quantidadeVariante).toBe(8); // derivado: soma dos tamanhos
      expect(produto.quantidadeTotal).toBe(8); // derivado: soma das variantes
    });

    it("cria um tamanho novo na variante quando `tamanho` (nome) é informado em vez de `tamanhoId`, desde que já esteja cadastrado nas configurações", async () => {
      const produto = await criarProduto();
      const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
      const dto: EntradaEstoqueDto = { produtoId: produto.id, varianteId: String(variante._id), tamanho: "G", quantidade: 4 };

      const atualizado = await service.entrada(dto, null);
      const varianteAtualizada = atualizado.variantes.find((item) => String(item._id) === String(variante._id))!;
      expect(varianteAtualizada.tamanhos).toHaveLength(1);
      expect(varianteAtualizada.tamanhos[0]?.tamanho).toBe("G");
      expect(varianteAtualizada.tamanhos[0]?.quantidade).toBe(4);
    });

    // Fase 54.2 — a entrada de estoque não pode mais criar implicitamente um
    // tamanho que não existe em `configuracoes.tamanhos` (seção 6: "ajustar
    // estoque não deve criar um novo tamanho fora da lista central").
    it("rejeita criar um tamanho novo via entrada de estoque quando ele não está cadastrado nas configurações", async () => {
      const produto = await criarProduto();
      const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
      const tamanhoInexistente = `GGG-${Date.now()}`;
      const dto: EntradaEstoqueDto = {
        produtoId: produto.id,
        varianteId: String(variante._id),
        tamanho: tamanhoInexistente,
        quantidade: 4,
      };

      await expect(service.entrada(dto, null)).rejects.toThrow(
        "Este tamanho não está cadastrado nas configurações da loja. Cadastre o tamanho antes de utilizá-lo em um produto.",
      );

      const produtoFinal = await produtosService.obterPorId(produto.id);
      const varianteFinal = produtoFinal.variantes.find((item) => String(item._id) === String(variante._id))!;
      expect(varianteFinal.tamanhos).toHaveLength(0); // nada foi criado
    });

    it("não exige cadastro nas configurações ao somar quantidade em um tamanho JÁ existente na variante (mesmo que removido das configurações depois)", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(2);
      // "M" já está cadastrado em configuracoes.tamanhos (beforeAll) — o
      // ponto deste teste é confirmar que informar o NOME (não o id) de um
      // tamanho que já existe NA VARIANTE nunca passa pela validação central,
      // já que nenhum vínculo novo está sendo criado.
      const dto: EntradaEstoqueDto = { produtoId, varianteId, tamanho: "M", quantidade: 3 };
      const atualizado = await service.entrada(dto, null);
      const variante = atualizado.variantes.find((item) => String(item._id) === varianteId)!;
      const tamanho = variante.tamanhos.find((item) => String(item._id) === tamanhoId)!;
      expect(tamanho.quantidade).toBe(5);
    });

    it("zera estoqueZeradoEm quando uma entrada tira o produto de saldo zero", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(1);
      // Esvazia primeiro (saída) para produzir o estado "zerado".
      await service.saida({ produtoId, varianteId, tamanhoId, quantidade: 1, motivo: "Ajuste de teste" }, null);
      const zerado = await produtosService.obterPorId(produtoId);
      expect(zerado.estoqueZeradoEm).not.toBeNull();

      const reabastecido = await service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 2 }, null);
      expect(reabastecido.estoqueZeradoEm).toBeNull();
      expect(reabastecido.quantidadeTotal).toBe(2);
    });

    it("registra a movimentação histórica de entrada com saldo resultante", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(2);
      await service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 5 }, "usuario-teste");

      const movimentacoes = await movimentacoesDoProduto(produtoId);
      expect(movimentacoes).toHaveLength(1);
      expect(movimentacoes[0]?.["tipo"]).toBe("entrada");
      expect(movimentacoes[0]?.["quantidade"]).toBe(5);
      expect(movimentacoes[0]?.["saldoResultante"]).toBe(7);
      expect(movimentacoes[0]?.["motivo"]).toBeNull(); // entrada não exige motivo
      expect(movimentacoes[0]?.["usuarioId"]).toBe("usuario-teste");
    });
  });

  describe("saída", () => {
    it("reduz a quantidade e atualiza os derivados", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(10);
      const dto: SaidaEstoqueDto = { produtoId, varianteId, tamanhoId, quantidade: 4, motivo: "Venda balcão" };

      const produto = await service.saida(dto, null);
      const variante = produto.variantes.find((item) => String(item._id) === varianteId)!;
      expect(variante.tamanhos[0]?.quantidade).toBe(6);
      expect(variante.quantidadeVariante).toBe(6);
      expect(produto.quantidadeTotal).toBe(6);
    });

    it("bloqueia saída maior que o saldo disponível, sem alterar a quantidade", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(3);
      await expect(
        service.saida({ produtoId, varianteId, tamanhoId, quantidade: 4, motivo: "Tentativa inválida" }, null),
      ).rejects.toThrow(ApiException);

      const produto = await produtosService.obterPorId(produtoId);
      expect(produto.quantidadeTotal).toBe(3); // nunca alterado pela tentativa rejeitada
    });

    it("marca estoqueZeradoEm quando a saída zera o saldo total do produto", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(2);
      const produto = await service.saida({ produtoId, varianteId, tamanhoId, quantidade: 2, motivo: "Saída total" }, null);
      expect(produto.quantidadeTotal).toBe(0);
      expect(produto.estoqueZeradoEm).not.toBeNull();
    });

    it("registra a movimentação histórica de saída com motivo e saldo resultante", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(10);
      await service.saida({ produtoId, varianteId, tamanhoId, quantidade: 4, motivo: "Peça avariada" }, "usuario-teste");

      const movimentacoes = await movimentacoesDoProduto(produtoId);
      expect(movimentacoes).toHaveLength(1);
      expect(movimentacoes[0]?.["tipo"]).toBe("saida");
      expect(movimentacoes[0]?.["quantidade"]).toBe(4);
      expect(movimentacoes[0]?.["saldoResultante"]).toBe(6);
      expect(movimentacoes[0]?.["motivo"]).toBe("Peça avariada");
    });

    it("nunca torna `movimentacoes_estoque` a fonte de verdade — a saída rejeitada não deixa rastro nenhum", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(1);
      await expect(
        service.saida({ produtoId, varianteId, tamanhoId, quantidade: 5, motivo: "Excede saldo" }, null),
      ).rejects.toThrow(ApiException);

      const movimentacoes = await movimentacoesDoProduto(produtoId);
      expect(movimentacoes).toHaveLength(0); // nenhuma movimentação para uma operação que nunca foi aplicada
      const produto = await produtosService.obterPorId(produtoId);
      expect(produto.quantidadeTotal).toBe(1); // a fonte de verdade continua sendo Produto.variantes[].tamanhos[].quantidade
    });
  });

  describe("erros", () => {
    it("produto inexistente: NOT_FOUND", async () => {
      const produto = await criarProduto();
      const variante = await produtosService.adicionarVariante(produto.id, { cor: "Vermelho" }, null);
      await expect(
        service.entrada({ produtoId: "65f1a2b3c4d5e6f7a8b9c0d1", varianteId: String(variante._id), tamanho: "M", quantidade: 1 }, null),
      ).rejects.toThrow(ApiException);
    });

    it("variante inexistente: NOT_FOUND", async () => {
      const produto = await criarProduto();
      await expect(
        service.entrada({ produtoId: produto.id, varianteId: "65f1a2b3c4d5e6f7a8b9c0d1", tamanho: "M", quantidade: 1 }, null),
      ).rejects.toThrow(ApiException);
    });

    it("tamanho inexistente na saída (exigirExistente): NOT_FOUND", async () => {
      const produto = await criarProduto();
      const variante = await produtosService.adicionarVariante(produto.id, { cor: "Amarelo" }, null);
      await expect(
        service.saida(
          { produtoId: produto.id, varianteId: String(variante._id), tamanhoId: "65f1a2b3c4d5e6f7a8b9c0d1", quantidade: 1, motivo: "Teste" },
          null,
        ),
      ).rejects.toThrow(ApiException);
    });

    // Etapa 18.13 — regra cruzando dois campos opcionais do DTO (`tamanhoId`
    // XOR `tamanho`), validada em `ProdutosService.ajustarQuantidadeTamanho`
    // (não no DTO, mesmo critério já usado para `fim >= inicio` em
    // Coleções/Campanhas) — sem teste dedicado até esta etapa.
    it("entrada sem tamanhoId E sem tamanho (nome): rejeitada com VALIDATION_ERROR, nunca cria um tamanho vazio", async () => {
      const produto = await criarProduto();
      const variante = await produtosService.adicionarVariante(produto.id, { cor: "Rosa" }, null);
      await expect(
        service.entrada({ produtoId: produto.id, varianteId: String(variante._id), quantidade: 1 } as EntradaEstoqueDto, null),
      ).rejects.toThrow(ApiException);

      const final = await produtosService.obterPorId(produto.id);
      const varFinal = final.variantes.find((v) => String(v._id) === String(variante._id))!;
      expect(varFinal.tamanhos).toHaveLength(0); // nenhum tamanho "fantasma" criado pela tentativa rejeitada
    });
  });

  describe("listagem", () => {
    it("devolve um array simples, sem paginação nem facetas no servidor", async () => {
      const resultado = await service.listar({});
      expect(Array.isArray(resultado)).toBe(true);
      expect(resultado).not.toHaveProperty("meta");
      expect(resultado).not.toHaveProperty("facets");
    });

    it("filtro disponibilidade=disponivel só devolve produtos com quantidadeTotal > 0", async () => {
      const comEstoque = await criarProdutoComTamanho(5);
      const semEstoque = await criarProduto();

      const resultado = await service.listar({ disponibilidade: "disponivel" });
      const ids = resultado.map((item) => item.produtoId);
      expect(ids).toContain(comEstoque.produtoId);
      expect(ids).not.toContain(semEstoque.id);
    });

    it("filtro disponibilidade=sem-estoque só devolve produtos com quantidadeTotal igual a zero", async () => {
      const comEstoque = await criarProdutoComTamanho(5);
      const semEstoque = await criarProduto();

      const resultado = await service.listar({ disponibilidade: "sem-estoque" });
      const ids = resultado.map((item) => item.produtoId);
      expect(ids).toContain(semEstoque.id);
      expect(ids).not.toContain(comEstoque.produtoId);
    });

    it("busca por nome ou código do produto", async () => {
      const s = sufixo();
      const nomeUnico = `Estoque Busca Único ${s}`;
      const produto = await criarProduto({ nome: nomeUnico });

      const porNome = await service.listar({ busca: nomeUnico });
      expect(porNome.map((item) => item.produtoId)).toContain(produto.id);

      const porCodigo = await service.listar({ busca: produto.codProduto });
      expect(porCodigo.map((item) => item.produtoId)).toContain(produto.id);
    });

    it("resumo reflete cores/tamanhos/quantidades corretamente", async () => {
      const { produtoId } = await criarProdutoComTamanho(7);
      const resultado = await service.listar({});
      const item = resultado.find((registro) => registro.produtoId === produtoId)!;
      expect(item.cores).toHaveLength(1);
      expect(item.cores[0]?.tamanhos).toHaveLength(1);
      expect(item.cores[0]?.tamanhos[0]?.quantidade).toBe(7);
      expect(item.quantidadeTotal).toBe(7);
      expect(item.totalVariantes).toBe(1);
    });

    it("Fase 60.1 — sem galeria, foto/fotos seguem exatamente a regra legada (foto da 1ª variante; fotos das variantes com foto)", async () => {
      const produto = await criarProduto();
      await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
      await produtosService.adicionarVariante(produto.id, { cor: "Rosa", foto: "https://exemplo.com/rosa.jpg" }, null);
      await inserirMidiaDiretamente(connection, produto.id, { tipo: "video", ordem: 0 }); // vídeo não conta como galeria de imagens
      const item = (await service.listar({ busca: produto.codProduto })).find((registro) => registro.produtoId === produto.id)!;
      expect(item.foto).toBeNull();
      expect(item.fotos).toEqual(["https://exemplo.com/rosa.jpg"]);
    });

    it("Fase 60.1 — com imagens na galeria, foto é a principal e fotos são as imagens pela ordem", async () => {
      const produto = await criarProduto();
      await produtosService.adicionarVariante(produto.id, { cor: "Rosa", foto: "https://exemplo.com/rosa.jpg" }, null);
      await inserirMidiaDiretamente(connection, produto.id, { ordem: 1, url: "https://midia.exemplo.com/b.jpg" });
      await inserirMidiaDiretamente(connection, produto.id, { ordem: 0, url: "https://midia.exemplo.com/a.jpg" });
      const principal = await inserirMidiaDiretamente(connection, produto.id, { ordem: 2, url: "https://midia.exemplo.com/c.jpg" });
      await connection.collection("produtos").updateOne({ _id: new Types.ObjectId(produto.id) }, { $set: { midiaPrincipalId: principal } });

      const item = (await service.listar({ busca: produto.codProduto })).find((registro) => registro.produtoId === produto.id)!;
      expect(item.foto).toBe("https://midia.exemplo.com/c.jpg");
      expect(item.fotos).toEqual(["https://midia.exemplo.com/a.jpg", "https://midia.exemplo.com/b.jpg", "https://midia.exemplo.com/c.jpg"]);
    });
  });

  describe("concorrência (mesma estratégia de salvarComRetentativa já usada em Produtos)", () => {
    it("duas saídas concorrentes disputando a ÚLTIMA unidade: exatamente uma sucede, saldo final nunca negativo", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(1);

      const resultados = await Promise.allSettled([
        service.saida({ produtoId, varianteId, tamanhoId, quantidade: 1, motivo: "Concorrente A" }, null),
        service.saida({ produtoId, varianteId, tamanhoId, quantidade: 1, motivo: "Concorrente B" }, null),
      ]);

      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(1);

      const final = await produtosService.obterPorId(produtoId);
      expect(final.quantidadeTotal).toBe(0); // nunca negativo

      const movimentacoes = await movimentacoesDoProduto(produtoId);
      expect(movimentacoes).toHaveLength(1); // só a saída que efetivamente aplicou gera histórico
    });

    it("duas entradas concorrentes no MESMO tamanho: as duas aplicam, soma final correta (nenhuma perdida)", async () => {
      // `salvarComRetentativa` usa um orçamento fixo de 3 tentativas (padrão já
      // existente, não alterado aqui). Com 2 escritores concorrentes, o
      // perdedor da corrida precisa de, no máximo, 1 nova tentativa para
      // convergir — folga confortável dentro do orçamento. Um fan-out maior
      // (ex.: 5 escritores) pode legitimamente esgotar as 3 tentativas do
      // "último da fila" sob contenção real — não é um bug, é o
      // comportamento aceito do mecanismo existente, então o teste não força
      // esse cenário.
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(0);

      const resultados = await Promise.allSettled([
        service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 1 }, "usuario-0"),
        service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 1 }, "usuario-1"),
      ]);
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

      const final = await produtosService.obterPorId(produtoId);
      expect(final.quantidadeTotal).toBe(2); // nenhuma entrada perdida por sobrescrita concorrente

      const movimentacoes = await movimentacoesDoProduto(produtoId);
      expect(movimentacoes).toHaveLength(2);
    });
  });

  // Fase 22.1 — porta única (`movimentar`): saldo + ledger na MESMA transação, e idempotência opcional por chave.
  describe("Fase 22.1 — porta única de movimentação (transação + idempotência)", () => {
    const espioes: { mockRestore: () => void }[] = [];
    afterEach(() => {
      while (espioes.length) espioes.pop()!.mockRestore();
    });

    function modelDoLedger(): Model<MovimentacaoEstoqueDocument> {
      return moduleRef.get<Model<MovimentacaoEstoqueDocument>>(getModelToken(MovimentacaoEstoque.name));
    }

    async function quantidadeDoTamanho(produtoId: string, tamanhoId: string): Promise<number> {
      const produto = await produtosService.obterPorId(produtoId);
      for (const variante of produto.variantes) {
        const tamanho = variante.tamanhos.find((item) => String(item._id) === tamanhoId);
        if (tamanho) return tamanho.quantidade;
      }
      throw new Error("tamanho não encontrado no teste");
    }

    function chave(): string {
      return `teste-22.1-${Date.now()}-${sufixo()}`;
    }

    async function codigoDoErro(promessa: Promise<unknown>): Promise<string> {
      try {
        await promessa;
      } catch (erro) {
        return erro instanceof ApiException ? String((erro.getResponse() as { code?: string }).code) : `NAO_API:${String(erro)}`;
      }
      return "SEM_ERRO";
    }

    it("o índice único parcial de idempotencyKey existe no ledger", async () => {
      const indices = await connection.collection("movimentacoes_estoque").indexes();
      const indice = indices.find((item) => item.name === "idempotencyKey_unico_parcial");
      expect(indice).toBeDefined();
      expect(indice?.unique).toBe(true);
      expect(indice?.partialFilterExpression).toEqual({ idempotencyKey: { $type: "string" } });
    });

    it("(1) entrada manual atualiza o saldo e cria EXATAMENTE um registro — sem chave, sem campos de idempotência", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(4);
      await service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 3 }, "usuario-22.1");

      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(7);
      const movimentacoes = await movimentacoesDoProduto(produtoId);
      expect(movimentacoes).toHaveLength(1);
      expect(movimentacoes[0]?.["tipo"]).toBe("entrada");
      expect(movimentacoes[0]?.["origem"]).toBe("manual");
      expect(movimentacoes[0]?.["saldoResultante"]).toBe(7);
      expect(movimentacoes[0]?.["usuarioId"]).toBe("usuario-22.1");
      // (9) compatibilidade: sem chave, o documento não ganha campos novos.
      expect("idempotencyKey" in movimentacoes[0]!).toBe(false);
      expect("idempotencyAssinatura" in movimentacoes[0]!).toBe(false);
    });

    it("(2) saída manual atualiza o saldo e cria EXATAMENTE um registro", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(6);
      await service.saida({ produtoId, varianteId, tamanhoId, quantidade: 2, motivo: "Avaria" }, null);

      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(4);
      const movimentacoes = await movimentacoesDoProduto(produtoId);
      expect(movimentacoes).toHaveLength(1);
      expect(movimentacoes[0]?.["tipo"]).toBe("saida");
      expect(movimentacoes[0]?.["motivo"]).toBe("Avaria");
      expect(movimentacoes[0]?.["saldoResultante"]).toBe(4);
    });

    it("(3) falha na gravação do ledger DESFAZ a alteração de saldo (o saldo foi alterado dentro da transação e revertido)", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(5);
      let saldoVistoDentroDaTransacao: number | null = null;

      const espiao = spyOn(modelDoLedger(), "create").mockImplementationOnce((async (_docs: unknown, opcoes: { session: ClientSession }) => {
        // Lê o produto NA SESSÃO da transação: prova que a baixa já foi escrita antes da falha do ledger.
        const visto = await connection
          .collection("produtos")
          .findOne({ _id: new Types.ObjectId(produtoId) }, { session: opcoes.session });
        const tamanho = (visto?.["variantes"] as { tamanhos: { _id: unknown; quantidade: number }[] }[])
          .flatMap((variante) => variante.tamanhos)
          .find((item) => String(item._id) === tamanhoId);
        saldoVistoDentroDaTransacao = tamanho?.quantidade ?? null;
        throw new Error("falha injetada na gravação do ledger");
      }) as never);
      espioes.push(espiao);

      expect(await codigoDoErro(service.saida({ produtoId, varianteId, tamanhoId, quantidade: 2, motivo: "Teste rollback" }, null))).toBe(
        "NAO_API:Error: falha injetada na gravação do ledger",
      );
      expect(espiao).toHaveBeenCalledTimes(1);
      expect(saldoVistoDentroDaTransacao as number | null).toBe(3); // dentro da transação a baixa existia…
      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(5); // …e foi desfeita no abort.
      expect(await movimentacoesDoProduto(produtoId)).toHaveLength(0);
    });

    it("(4) falha na atualização do saldo não deixa registro de movimentação (ledger nunca é chamado)", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(5);
      const repositorio = moduleRef.get(ProdutosRepository);
      const espiaoSalvar = spyOn(repositorio, "salvarComRetentativa").mockImplementationOnce((async () => {
        throw new Error("falha injetada ao salvar o saldo");
      }) as never);
      const espiaoLedger = spyOn(modelDoLedger(), "create");
      espioes.push(espiaoSalvar, espiaoLedger);

      expect(await codigoDoErro(service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 2 }, null))).toBe(
        "NAO_API:Error: falha injetada ao salvar o saldo",
      );
      expect(espiaoLedger).toHaveBeenCalledTimes(0);
      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(5);
      expect(await movimentacoesDoProduto(produtoId)).toHaveLength(0);
    });

    it("(5) a MESMA chave com o MESMO conteúdo não duplica a operação (entrada e saída) e devolve o produto", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(10);
      const chaveEntrada = chave();
      const primeira = await service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 3, idempotencyKey: chaveEntrada }, "u1");
      const repetida = await service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 3, idempotencyKey: chaveEntrada }, "u2");
      expect(primeira.quantidadeTotal).toBe(13);
      expect(repetida.quantidadeTotal).toBe(13);
      expect(repetida.id).toBe(produtoId);

      const chaveSaida = chave();
      await service.saida({ produtoId, varianteId, tamanhoId, quantidade: 4, motivo: " Ajuste ", idempotencyKey: chaveSaida }, null);
      // motivo com espaços diferentes nas pontas é a MESMA operação (assinatura usa o motivo aparado)
      await service.saida({ produtoId, varianteId, tamanhoId, quantidade: 4, motivo: "Ajuste", idempotencyKey: chaveSaida }, null);

      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(9);
      const movimentacoes = await movimentacoesDoProduto(produtoId);
      expect(movimentacoes).toHaveLength(2);
      expect(movimentacoes.map((item) => item["idempotencyKey"]).sort()).toEqual([chaveEntrada, chaveSaida].sort());
    });

    it("(6) a mesma chave com conteúdo DIFERENTE responde 409 e não altera nada", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(10);
      const k = chave();
      await service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 2, idempotencyKey: k }, null);

      // quantidade diferente
      expect(await codigoDoErro(service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 5, idempotencyKey: k }, null))).toBe("CONFLICT");
      // operação diferente (mesma chave usada numa saída)
      expect(await codigoDoErro(service.saida({ produtoId, varianteId, tamanhoId, quantidade: 2, motivo: "x", idempotencyKey: k }, null))).toBe(
        "CONFLICT",
      );
      // outro produto
      const outro = await criarProdutoComTamanho(1);
      expect(
        await codigoDoErro(
          service.entrada({ produtoId: outro.produtoId, varianteId: outro.varianteId, tamanhoId: outro.tamanhoId, quantidade: 2, idempotencyKey: k }, null),
        ),
      ).toBe("CONFLICT");

      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(12);
      expect(await quantidadeDoTamanho(outro.produtoId, outro.tamanhoId)).toBe(1);
      expect(await movimentacoesDoProduto(produtoId)).toHaveLength(1);
      expect(await movimentacoesDoProduto(outro.produtoId)).toHaveLength(0);
    });

    it("(7) saldo insuficiente bloqueia a saída (com chave) e NÃO consome a chave — depois de repor, a mesma chave aplica", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(1);
      const k = chave();
      expect(await codigoDoErro(service.saida({ produtoId, varianteId, tamanhoId, quantidade: 3, motivo: "Perda", idempotencyKey: k }, null))).toBe(
        "VALIDATION_ERROR",
      );
      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(1);
      expect(await movimentacoesDoProduto(produtoId)).toHaveLength(0);

      await service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 5 }, null);
      await service.saida({ produtoId, varianteId, tamanhoId, quantidade: 3, motivo: "Perda", idempotencyKey: k }, null);
      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(3);
      expect(await movimentacoesDoProduto(produtoId)).toHaveLength(2);
    });

    it("(8a) saídas concorrentes: saldo nunca negativo e saldo final = inicial − soma do ledger (sucessos = registros)", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(3);
      const resultados = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => service.saida({ produtoId, varianteId, tamanhoId, quantidade: 1, motivo: `Concorrente ${i}` }, null)),
      );
      const sucessos = resultados.filter((r) => r.status === "fulfilled").length;
      for (const r of resultados) {
        if (r.status === "rejected") {
          // só recusas de regra (saldo) ou de conflito esgotado — nunca erro cru
          expect(r.reason instanceof ApiException).toBe(true);
          expect(["VALIDATION_ERROR", "CONFLICT"]).toContain(String((r.reason.getResponse() as { code?: string }).code));
        }
      }
      const saldo = await quantidadeDoTamanho(produtoId, tamanhoId);
      const movimentacoes = await movimentacoesDoProduto(produtoId);
      expect(saldo).toBeGreaterThanOrEqual(0);
      expect(movimentacoes).toHaveLength(sucessos);
      expect(saldo).toBe(3 - movimentacoes.reduce((total, item) => total + Number(item["quantidade"]), 0));
      expect(sucessos).toBeLessThanOrEqual(3);
    });

    it("(8b) a MESMA chave enviada 5× ao mesmo tempo aplica UMA vez só; as demais recebem o replay", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(0);
      const k = chave();
      const resultados = await Promise.allSettled(
        Array.from({ length: 5 }, () => service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 2, idempotencyKey: k }, null)),
      );
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);
      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(2);
      expect(await movimentacoesDoProduto(produtoId)).toHaveLength(1);
    });

    it("(9) sem chave, duas requisições iguais continuam lançando duas vezes (comportamento anterior preservado)", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(0);
      await service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 1 }, null);
      await service.entrada({ produtoId, varianteId, tamanhoId, quantidade: 1 }, null);
      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(2);
      expect(await movimentacoesDoProduto(produtoId)).toHaveLength(2);
    });

    it("movimentar() rejeita quantidade não inteira/≤0 e tipo inválido antes de qualquer escrita", async () => {
      const { produtoId, varianteId, tamanhoId } = await criarProdutoComTamanho(2);
      const base = { produtoId, varianteId, tamanhoId, motivo: null, usuarioId: null, origem: "manual" as const };
      const sessao = await connection.startSession();
      try {
        expect(await codigoDoErro(service.movimentar({ ...base, tipo: "entrada", quantidade: 0 }, sessao))).toBe("VALIDATION_ERROR");
        expect(await codigoDoErro(service.movimentar({ ...base, tipo: "entrada", quantidade: 1.5 }, sessao))).toBe("VALIDATION_ERROR");
        expect(await codigoDoErro(service.movimentar({ ...base, tipo: "ajuste" as never, quantidade: 1 }, sessao))).toBe("VALIDATION_ERROR");
      } finally {
        await sessao.endSession();
      }
      expect(await quantidadeDoTamanho(produtoId, tamanhoId)).toBe(2);
      expect(await movimentacoesDoProduto(produtoId)).toHaveLength(0);
    });
  });
});
