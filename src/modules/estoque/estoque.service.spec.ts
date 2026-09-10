import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { EstoqueModule } from "./estoque.module.js";
import { EstoqueService } from "./estoque.service.js";
import type { EntradaEstoqueDto } from "./dto/entrada-estoque.dto.js";
import type { SaidaEstoqueDto } from "./dto/saida-estoque.dto.js";

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
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, EstoqueModule],
    }).compile();
    service = moduleRef.get(EstoqueService);
    produtosService = moduleRef.get(ProdutosService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("movimentacoes_estoque").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["produto"] } });
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
  async function movimentacoesDoProduto(produtoId: string) {
    return connection.collection("movimentacoes_estoque").find({ produtoId: new Types.ObjectId(produtoId) }).toArray();
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

    it("cria um tamanho novo na variante quando `tamanho` (nome) é informado em vez de `tamanhoId`", async () => {
      const produto = await criarProduto();
      const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
      const dto: EntradaEstoqueDto = { produtoId: produto.id, varianteId: String(variante._id), tamanho: "G", quantidade: 4 };

      const atualizado = await service.entrada(dto, null);
      const varianteAtualizada = atualizado.variantes.find((item) => String(item._id) === String(variante._id))!;
      expect(varianteAtualizada.tamanhos).toHaveLength(1);
      expect(varianteAtualizada.tamanhos[0]?.tamanho).toBe("G");
      expect(varianteAtualizada.tamanhos[0]?.quantidade).toBe(4);
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
});
