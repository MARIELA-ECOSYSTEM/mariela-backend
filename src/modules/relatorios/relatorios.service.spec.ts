import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import type { ProdutosRepository } from "../produtos/produtos.repository.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { RelatoriosModule } from "./relatorios.module.js";
import { RelatoriosService } from "./relatorios.service.js";

interface ProdutoFalso {
  nome: string;
  categoria: string;
  precoCusto: number;
  precoVenda: number;
  ehPromocao: boolean;
  precoPromocional: number | null;
  quantidadeTotal: number;
  margemLucro: number;
  variantes: unknown[];
  criadoEm: Date;
}

let sequencia = 0;
function produtoFalso(extra: Partial<ProdutoFalso> = {}): ProdutoFalso {
  sequencia += 1;
  return {
    nome: `Produto ${sequencia}`,
    categoria: "Vestidos",
    precoCusto: 50,
    precoVenda: 100,
    ehPromocao: false,
    precoPromocional: null,
    quantidadeTotal: 0,
    margemLucro: 50,
    variantes: [],
    criadoEm: new Date(),
    ...extra,
  };
}

/** Service isolado: só depende de `listarTodosAtivos()`, então a agregação é testada de forma determinística. */
function servicoCom(produtos: ProdutoFalso[]): RelatoriosService {
  const repositorio = { listarTodosAtivos: async () => produtos } as unknown as ProdutosRepository;
  return new RelatoriosService(repositorio);
}

describe("RelatoriosService — agregações (unidade, dados controlados)", () => {
  afterEach(() => {
    setSystemTime();
  });

  it("sem produtos: tudo zerado, sem divisão por zero, demonstracao=false e 6 meses de histórico zerados", async () => {
    const resumo = await servicoCom([]).resumo();

    expect(resumo.demonstracao).toBe(false);
    expect(resumo.totalProdutos).toBe(0);
    expect(resumo.totalVariantes).toBe(0);
    expect(resumo.pecasEmEstoque).toBe(0);
    expect(resumo.produtosSemEstoque).toBe(0);
    expect(resumo.valorCustoEstoque).toBe(0);
    expect(resumo.valorVendaEstoque).toBe(0);
    expect(resumo.margemMediaPercentual).toBe(0);
    expect(resumo.produtosPorCategoria).toEqual([]);
    expect(resumo.pecasPorCategoria).toEqual([]);
    expect(resumo.topEstoque).toEqual([]);
    expect(resumo.cadastrosPorMes).toHaveLength(6);
    expect(resumo.cadastrosPorMes.every((ponto) => ponto.valor === 0)).toBe(true);
  });

  it("geradoEm é a data/hora atual em ISO", async () => {
    setSystemTime(new Date("2026-03-10T15:30:00.000Z"));
    const resumo = await servicoCom([]).resumo();
    expect(resumo.geradoEm).toBe("2026-03-10T15:30:00.000Z");
  });

  it("estoque: peças, custo e venda potencial multiplicam pela quantidade; produto zerado conta em produtosSemEstoque", async () => {
    const resumo = await servicoCom([
      produtoFalso({ precoCusto: 40, precoVenda: 100, quantidadeTotal: 3, variantes: [{}, {}] }),
      produtoFalso({ precoCusto: 10, precoVenda: 30, quantidadeTotal: 5, variantes: [{}] }),
      produtoFalso({ precoCusto: 999, precoVenda: 999, quantidadeTotal: 0 }),
    ]).resumo();

    expect(resumo.totalProdutos).toBe(3);
    expect(resumo.totalVariantes).toBe(3);
    expect(resumo.pecasEmEstoque).toBe(8);
    expect(resumo.produtosSemEstoque).toBe(1);
    expect(resumo.valorCustoEstoque).toBe(170); // 40*3 + 10*5
    expect(resumo.valorVendaEstoque).toBe(450); // 100*3 + 30*5
  });

  it("valor de venda do estoque usa o preço promocional (efetivo) quando a promoção está ativa", async () => {
    const resumo = await servicoCom([
      produtoFalso({ precoVenda: 200, ehPromocao: true, precoPromocional: 150, quantidadeTotal: 2 }),
      produtoFalso({ precoVenda: 100, ehPromocao: false, precoPromocional: 80, quantidadeTotal: 1 }), // promoção desligada: ignora 80
    ]).resumo();

    expect(resumo.valorVendaEstoque).toBe(400); // 150*2 + 100*1
  });

  it("margem média: média simples das margens persistidas, ignorando produtos com custo 0", async () => {
    const resumo = await servicoCom([
      produtoFalso({ precoCusto: 50, margemLucro: 50 }),
      produtoFalso({ precoCusto: 20, margemLucro: 30 }),
      produtoFalso({ precoCusto: 0, margemLucro: 99 }), // excluído do cálculo
    ]).resumo();

    expect(resumo.margemMediaPercentual).toBe(40);
  });

  it("margem média é arredondada para 2 casas", async () => {
    const resumo = await servicoCom([
      produtoFalso({ margemLucro: 10 }),
      produtoFalso({ margemLucro: 10 }),
      produtoFalso({ margemLucro: 10.01 }),
    ]).resumo();

    expect(resumo.margemMediaPercentual).toBe(10);
  });

  it("séries por categoria: contagem e peças agrupadas, ordenadas do maior para o menor", async () => {
    const resumo = await servicoCom([
      produtoFalso({ categoria: "Blusas", quantidadeTotal: 1 }),
      produtoFalso({ categoria: "Vestidos", quantidadeTotal: 10 }),
      produtoFalso({ categoria: "Vestidos", quantidadeTotal: 4 }),
      produtoFalso({ categoria: "Saias", quantidadeTotal: 6 }),
    ]).resumo();

    expect(resumo.produtosPorCategoria).toEqual([
      { label: "Vestidos", valor: 2 },
      { label: "Blusas", valor: 1 },
      { label: "Saias", valor: 1 },
    ]);
    expect(resumo.pecasPorCategoria).toEqual([
      { label: "Vestidos", valor: 14 },
      { label: "Saias", valor: 6 },
      { label: "Blusas", valor: 1 },
    ]);
  });

  it("topEstoque: no máximo 6 produtos, do maior para o menor estoque", async () => {
    const produtos = Array.from({ length: 8 }, (_, indice) =>
      produtoFalso({ nome: `P${indice}`, quantidadeTotal: indice * 10 }),
    );
    const resumo = await servicoCom(produtos).resumo();

    expect(resumo.topEstoque).toHaveLength(6);
    expect(resumo.topEstoque.map((item) => item.label)).toEqual(["P7", "P6", "P5", "P4", "P3", "P2"]);
    expect(resumo.topEstoque.map((item) => item.valor)).toEqual([70, 60, 50, 40, 30, 20]);
  });

  it("cadastrosPorMes: janela dos últimos 6 meses (do mais antigo ao atual), contando por mês de criação", async () => {
    setSystemTime(new Date(2026, 8, 15, 12, 0, 0)); // 15/set/2026, hora local
    const resumo = await servicoCom([
      produtoFalso({ criadoEm: new Date(2026, 8, 2) }), // set
      produtoFalso({ criadoEm: new Date(2026, 8, 20) }), // set
      produtoFalso({ criadoEm: new Date(2026, 6, 10) }), // jul
      produtoFalso({ criadoEm: new Date(2026, 3, 5) }), // abr (mais antigo da janela)
      produtoFalso({ criadoEm: new Date(2026, 2, 28) }), // mar: fora da janela
      produtoFalso({ criadoEm: new Date(2025, 8, 15) }), // set/2025: mesmo mês do ano anterior, fora da janela
    ]).resumo();

    expect(resumo.cadastrosPorMes.map((ponto) => ponto.valor)).toEqual([1, 0, 0, 1, 0, 2]); // abr, mai, jun, jul, ago, set
    expect(resumo.cadastrosPorMes[5]!.label).toBe(
      new Date(2026, 8, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }),
    );
    expect(resumo.cadastrosPorMes[0]!.label).toBe(
      new Date(2026, 3, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }),
    );
  });
});

const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

describe("RelatoriosService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: RelatoriosService;
  let produtosService: ProdutosService;
  let connection: Connection;
  const idsCriados: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, RelatoriosModule],
    }).compile();
    service = moduleRef.get(RelatoriosService);
    produtosService = moduleRef.get(ProdutosService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    for (const id of idsCriados) {
      await connection.collection("produtos").deleteOne({ _id: new Types.ObjectId(id) });
      await connection.collection("eventos_produto").deleteMany({ produtoId: new Types.ObjectId(id) });
    }
    await moduleRef.close();
  });

  it("um produto novo com estoque e promoção reflete nos indicadores reais (deltas sobre o estado anterior)", async () => {
    const antes = await service.resumo();

    const produto = await produtosService.criar(
      { nome: `Relatorio ${Date.now()}`, categoria: "CategoriaRelatorioTeste", precoCusto: 50, precoVenda: 200, ehNovidade: false },
      null,
    );
    idsCriados.push(produto.id);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const varianteId = String((variante as unknown as { _id: unknown })._id);
    await produtosService.ajustarQuantidadeTamanho(produto.id, varianteId, {
      tamanho: "M",
      delta: 4,
      exigirExistente: false,
    });
    await produtosService.definirPromocao(produto.id, { ehPromocao: true, precoPromocional: 150 }, null);

    const depois = await service.resumo();
    expect(depois.demonstracao).toBe(false);
    expect(depois.totalProdutos).toBe(antes.totalProdutos + 1);
    expect(depois.totalVariantes).toBe(antes.totalVariantes + 1);
    expect(depois.pecasEmEstoque).toBe(antes.pecasEmEstoque + 4);
    expect(depois.valorCustoEstoque).toBeCloseTo(antes.valorCustoEstoque + 200, 2); // 50*4
    expect(depois.valorVendaEstoque).toBeCloseTo(antes.valorVendaEstoque + 600, 2); // 150*4 (promocional)
    expect(depois.produtosPorCategoria.find((item) => item.label === "CategoriaRelatorioTeste")?.valor).toBe(1);
    expect(depois.pecasPorCategoria.find((item) => item.label === "CategoriaRelatorioTeste")?.valor).toBe(4);
    expect(depois.cadastrosPorMes.at(-1)!.valor).toBe(antes.cadastrosPorMes.at(-1)!.valor + 1);
  });
});
