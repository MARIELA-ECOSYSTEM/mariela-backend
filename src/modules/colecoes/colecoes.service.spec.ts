import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { CriarColecaoDto } from "./dto/criar-colecao.dto.js";
import type { ListarColecoesQueryDto } from "./dto/listar-colecoes-query.dto.js";
import { ColecoesModule } from "./colecoes.module.js";
import { ColecoesService } from "./colecoes.service.js";

// `ColecoesController` usa `@UseGuards(JwtAuthGuard)`, que injeta `JwtService`
// — só disponível globalmente via `AppModule` de verdade. Este teste foca no
// service, então basta um `JwtModule` local mínimo.
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

function payloadColecao(sufixo: string, extra: Partial<CriarColecaoDto> = {}): CriarColecaoDto {
  return {
    nome: `Coleção Teste ${sufixo}`,
    inicio: "2026-01-01",
    fim: "2026-03-31",
    ...extra,
  };
}

function payloadProduto(sufixo: string, extra: Partial<CriarProdutoDto> = {}): CriarProdutoDto {
  return {
    nome: `Produto Teste ${sufixo}`,
    categoria: "Vestidos",
    precoCusto: 50,
    precoVenda: 100,
    ehNovidade: false,
    ...extra,
  };
}

function queryPadrao(extra: Partial<ListarColecoesQueryDto> = {}): ListarColecoesQueryDto {
  return {
    ordenarPor: "nome",
    ordem: "asc",
    situacao: [],
    destaque: [],
    banner: [],
    produtos: [],
    page: 1,
    limit: 20,
    ...extra,
  };
}

describe("ColecoesService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: ColecoesService;
  let produtosService: ProdutosService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, ColecoesModule],
    }).compile();
    service = moduleRef.get(ColecoesService);
    produtosService = moduleRef.get(ProdutosService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("colecoes").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["colecao", "produto"] } });
    await connection.collection("eventos_colecao").deleteMany({});
    await moduleRef.close();
  });

  describe("criação e código", () => {
    it("cria uma coleção com código sequencial gerado pelo backend e agregado zerado", async () => {
      const colecao = await service.criar(payloadColecao("A"), null);
      expect(colecao.codigo).toMatch(/^COL-\d{4}$/);
      expect(colecao.produtosVinculados).toBe(0);
      expect(colecao.ativo).toBe(true);
    });

    it("gera códigos distintos e sequenciais para coleções sucessivas", async () => {
      const primeiro = await service.criar(payloadColecao("B1"), null);
      const segundo = await service.criar(payloadColecao("B2"), null);
      const seqPrimeiro = Number(primeiro.codigo.split("-")[1]);
      const seqSegundo = Number(segundo.codigo.split("-")[1]);
      expect(seqSegundo).toBe(seqPrimeiro + 1);
    });

    it("rejeita fim anterior ao início", async () => {
      await expect(
        service.criar(payloadColecao("C", { inicio: "2026-06-01", fim: "2026-01-01" }), null),
      ).rejects.toThrow(ApiException);
    });

    it("descarta fotoDestaque quando destaque=false", async () => {
      const colecao = await service.criar(payloadColecao("D", { destaque: false, fotoDestaque: "https://x" }), null);
      expect(colecao.fotoDestaque).toBeNull();
    });

    it("preserva fotoDestaque quando destaque=true", async () => {
      const colecao = await service.criar(payloadColecao("E", { destaque: true, fotoDestaque: "https://x" }), null);
      expect(colecao.fotoDestaque).toBe("https://x");
    });

    it("registra o evento colecao.criada com o usuário autenticado", async () => {
      const colecao = await service.criar(payloadColecao("F"), "usuario-teste-1");
      const eventos = await connection.collection("eventos_colecao").find({ tipo: "colecao.criada" }).toArray();
      expect(
        eventos.some((item) => String(item["colecaoId"]) === colecao.id && item["usuarioId"] === "usuario-teste-1"),
      ).toBe(true);
    });

    it("nunca repete nem pula código sob criações concorrentes", async () => {
      const chamadas = Array.from({ length: 15 }, (_, indice) => service.criar(payloadColecao(`CONC-${indice}`), null));
      const colecoes = await Promise.all(chamadas);
      const codigos = new Set(colecoes.map((colecao) => colecao.codigo));
      expect(codigos.size).toBe(15);
    });
  });

  describe("busca, listagem e paginação", () => {
    it("busca uma coleção pelo id", async () => {
      const criada = await service.criar(payloadColecao("G"), null);
      const encontrada = await service.obterPorId(criada.id);
      expect(encontrada.codigo).toBe(criada.codigo);
    });

    it("lança NOT_FOUND para um id inexistente", async () => {
      await expect(service.obterPorId("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("busca por nome e descrição", async () => {
      const prefixo = `Busca${Date.now()}`;
      await service.criar(payloadColecao("H", { nome: prefixo, descricao: "Peças leves de verão" }), null);
      const porNome = await service.listar(queryPadrao({ busca: prefixo }));
      const porDescricao = await service.listar(queryPadrao({ busca: "leves de verão" }));
      expect(porNome.data).toHaveLength(1);
      expect(porDescricao.data).toHaveLength(1);
    });

    it("pagina corretamente quando há mais registros que o limite", async () => {
      const prefixo = `Pag${Date.now()}`;
      await Promise.all(
        Array.from({ length: 5 }, (_, indice) => service.criar(payloadColecao(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
      );
      const primeiraPagina = await service.listar(queryPadrao({ busca: prefixo, limit: 2, page: 1 }));
      const segundaPagina = await service.listar(queryPadrao({ busca: prefixo, limit: 2, page: 2 }));
      expect(primeiraPagina.data).toHaveLength(2);
      expect(segundaPagina.data).toHaveLength(2);
      expect(primeiraPagina.meta.total).toBe(5);
      expect(primeiraPagina.meta.totalPages).toBe(3);
      expect(primeiraPagina.data[0]?.id).not.toBe(segundaPagina.data[0]?.id);
    });

    it("ordena por nome (asc/desc)", async () => {
      const prefixo = `Ord${Date.now()}`;
      await service.criar(payloadColecao("Z", { nome: `${prefixo} Zulu` }), null);
      await service.criar(payloadColecao("A", { nome: `${prefixo} Alfa` }), null);
      const asc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "asc" }));
      const desc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "desc" }));
      expect(asc.data[0]?.nome).toContain("Alfa");
      expect(desc.data[0]?.nome).toContain("Zulu");
    });
  });

  describe("situação derivada (facetas)", () => {
    it("filtro situacao=inativa retorna coleções com ativo=false", async () => {
      const prefixo = `Sit${Date.now()}`;
      await service.criar(payloadColecao("SIT1", { nome: `${prefixo} 1`, ativo: false }), null);
      await service.criar(payloadColecao("SIT2", { nome: `${prefixo} 2`, ativo: true }), null);

      const inativas = await service.listar(queryPadrao({ busca: prefixo, situacao: ["inativa"] }));
      expect(inativas.data).toHaveLength(1);
      expect(inativas.data[0]?.ativo).toBe(false);
    });

    it("filtro situacao=agendada retorna coleções com início no futuro", async () => {
      const prefixo = `Agenda${Date.now()}`;
      const futuro = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const futuroFim = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
      await service.criar(payloadColecao("AG1", { nome: prefixo, inicio: futuro, fim: futuroFim, ativo: true }), null);

      const agendadas = await service.listar(queryPadrao({ busca: prefixo, situacao: ["agendada"] }));
      expect(agendadas.data).toHaveLength(1);
    });
  });

  describe("agregado de produtos vinculados", () => {
    it("produtosVinculados reflete os produtos ATIVOS vinculados", async () => {
      const colecao = await service.criar(payloadColecao("AGG"), null);
      await produtosService.criar(payloadProduto("AGG-1", { colecaoId: colecao.id }), null);
      await produtosService.criar(payloadProduto("AGG-2", { colecaoId: colecao.id }), null);
      await produtosService.criar(payloadProduto("AGG-3"), null); // sem coleção — não deve contar

      const atualizada = await service.obterPorId(colecao.id);
      expect(atualizada.produtosVinculados).toBe(2);
    });

    it("filtro produtos=sem só retorna coleções sem produtos vinculados", async () => {
      const prefixo = `FiltroProd${Date.now()}`;
      const comProduto = await service.criar(payloadColecao("FP1", { nome: `${prefixo} Com` }), null);
      await service.criar(payloadColecao("FP2", { nome: `${prefixo} Sem` }), null);
      await produtosService.criar(payloadProduto("FP-produto", { colecaoId: comProduto.id }), null);

      const semProdutos = await service.listar(queryPadrao({ busca: prefixo, produtos: ["sem"] }));
      expect(semProdutos.data).toHaveLength(1);
      expect(semProdutos.data[0]?.nome).toContain("Sem");
    });

    it("facets do grupo destaque contam sobre o conjunto completo, não a página", async () => {
      const prefixo = `FacetCol${Date.now()}`;
      await service.criar(payloadColecao("FC1", { nome: `${prefixo} 1`, destaque: true }), null);
      await service.criar(payloadColecao("FC2", { nome: `${prefixo} 2` }), null);
      await service.criar(payloadColecao("FC3", { nome: `${prefixo} 3` }), null);

      const resultado = await service.listar(queryPadrao({ busca: prefixo, limit: 1 }));
      expect(resultado.data).toHaveLength(1);
      const destaque = resultado.facets["destaque"] ?? [];
      const sim = destaque.find((opcao) => opcao.valor === "sim")?.count ?? 0;
      const nao = destaque.find((opcao) => opcao.valor === "nao")?.count ?? 0;
      expect(sim).toBe(1);
      expect(nao).toBe(2);
    });
  });

  describe("atualização e status", () => {
    it("atualiza os dados da coleção", async () => {
      const criada = await service.criar(payloadColecao("I"), null);
      const atualizada = await service.atualizar(criada.id, payloadColecao("I", { nome: "Nome Atualizado" }), null);
      expect(atualizada.nome).toBe("Nome Atualizado");
    });

    it("rejeita atualização com fim anterior ao início", async () => {
      const criada = await service.criar(payloadColecao("J"), null);
      await expect(
        service.atualizar(criada.id, payloadColecao("J", { inicio: "2026-06-01", fim: "2026-01-01" }), null),
      ).rejects.toThrow(ApiException);
    });

    it("alterarStatus ativa/inativa a coleção", async () => {
      const criada = await service.criar(payloadColecao("K", { ativo: true }), null);
      const inativada = await service.alterarStatus(criada.id, { ativo: false }, null);
      expect(inativada.ativo).toBe(false);
      const reativada = await service.alterarStatus(criada.id, { ativo: true }, null);
      expect(reativada.ativo).toBe(true);
    });
  });

  describe("exclusão (soft delete e bloqueio por vínculo)", () => {
    it("some da listagem/detalhe após excluída, mas o documento continua no banco", async () => {
      const criada = await service.criar(payloadColecao("L"), null);
      await service.excluir(criada.id, null);
      await expect(service.obterPorId(criada.id)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("colecoes").findOne({ codigo: criada.codigo });
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });

    it("não reaproveita o código de uma coleção excluída", async () => {
      const excluida = await service.criar(payloadColecao("M1"), null);
      await service.excluir(excluida.id, null);
      const nova = await service.criar(payloadColecao("M2"), null);
      expect(nova.codigo).not.toBe(excluida.codigo);
    });

    it("bloqueia a exclusão quando há produtos ativos vinculados", async () => {
      const colecao = await service.criar(payloadColecao("N"), null);
      await produtosService.criar(payloadProduto("N-produto", { colecaoId: colecao.id }), null);
      await expect(service.excluir(colecao.id, null)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("colecoes").findOne({ codigo: colecao.codigo });
      expect(bruto?.["excluidoEm"]).toBeNull();
    });
  });

  describe("produtos vinculados (detalhe)", () => {
    it("lista os produtos atualmente vinculados", async () => {
      const colecao = await service.criar(payloadColecao("O"), null);
      await produtosService.criar(payloadProduto("O-1", { colecaoId: colecao.id }), null);
      await produtosService.criar(payloadProduto("O-2", { colecaoId: colecao.id }), null);
      await produtosService.criar(payloadProduto("O-outro"), null);

      const produtos = await service.listarProdutos(colecao.id);
      expect(produtos).toHaveLength(2);
    });

    it("lança NOT_FOUND para uma coleção inexistente", async () => {
      await expect(service.listarProdutos("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });
  });

  describe("listarTodosAtivos() — contrato legado sem paginação (Etapa 15.2)", () => {
    it("devolve todas as coleções ativas, sem truncar por um limite padrão", async () => {
      const prefixo = `Full${Date.now()}`;
      await Promise.all(
        Array.from({ length: 25 }, (_, indice) => service.criar(payloadColecao(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
      );
      const todas = await service.listarTodosAtivos();
      const doPrefixo = todas.filter((colecao) => colecao.nome.startsWith(prefixo));
      expect(doPrefixo).toHaveLength(25); // nunca truncado em 20 (LIMITE_PADRAO), ao contrário de listar()
    });

    it("nunca inclui coleções excluídas (soft delete)", async () => {
      const ativa = await service.criar(payloadColecao("VisTodas"), null);
      const excluida = await service.criar(payloadColecao("InvTodas"), null);
      await service.excluir(excluida.id, null);

      const todas = await service.listarTodosAtivos();
      const ids = todas.map((colecao) => colecao.id);
      expect(ids).toContain(ativa.id);
      expect(ids).not.toContain(excluida.id);
    });

    it("calcula produtosVinculados exatamente como listar()", async () => {
      const colecao = await service.criar(payloadColecao("AgrTodas"), null);
      await produtosService.criar(payloadProduto("AgrTodas-1", { colecaoId: colecao.id }), null);
      await produtosService.criar(payloadProduto("AgrTodas-2", { colecaoId: colecao.id }), null);

      const todas = await service.listarTodosAtivos();
      const encontrada = todas.find((item) => item.id === colecao.id)!;
      expect(encontrada.produtosVinculados).toBe(2);
    });

    it("é estável sob execuções repetidas (mesmo resultado toda vez)", async () => {
      const prefixo = `Estavel${Date.now()}`;
      await service.criar(payloadColecao("Estavel1", { nome: prefixo }), null);

      const resultados = await Promise.all(Array.from({ length: 5 }, () => service.listarTodosAtivos()));
      const contagens = resultados.map((todas) => todas.filter((colecao) => colecao.nome === prefixo).length);
      expect(contagens).toEqual([1, 1, 1, 1, 1]);
    });
  });
});
