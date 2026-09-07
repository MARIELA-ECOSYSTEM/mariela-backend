import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { CriarCampanhaDto } from "./dto/criar-campanha.dto.js";
import type { ListarCampanhasQueryDto } from "./dto/listar-campanhas-query.dto.js";
import { CampanhasModule } from "./campanhas.module.js";
import { CampanhasService } from "./campanhas.service.js";

// `CampanhasController` usa `@UseGuards(JwtAuthGuard)`, que injeta `JwtService`
// — só disponível globalmente via `AppModule` de verdade. Este teste foca no
// service, então basta um `JwtModule` local mínimo.
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

function payloadCampanha(sufixo: string, extra: Partial<CriarCampanhaDto> = {}): CriarCampanhaDto {
  return {
    nome: `Campanha Teste ${sufixo}`,
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

function queryPadrao(extra: Partial<ListarCampanhasQueryDto> = {}): ListarCampanhasQueryDto {
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

describe("CampanhasService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: CampanhasService;
  let produtosService: ProdutosService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, CampanhasModule],
    }).compile();
    service = moduleRef.get(CampanhasService);
    produtosService = moduleRef.get(ProdutosService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("campanhas").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["campanha", "produto"] } });
    await connection.collection("eventos_campanha").deleteMany({});
    await moduleRef.close();
  });

  describe("criação e código", () => {
    it("cria uma campanha com código sequencial gerado pelo backend e agregado zerado", async () => {
      const campanha = await service.criar(payloadCampanha("A"), null);
      expect(campanha.codigo).toMatch(/^CAM-\d{4}$/);
      expect(campanha.produtosVinculados).toBe(0);
      expect(campanha.ativo).toBe(true);
    });

    it("gera códigos distintos e sequenciais para campanhas sucessivas", async () => {
      const primeiro = await service.criar(payloadCampanha("B1"), null);
      const segundo = await service.criar(payloadCampanha("B2"), null);
      const seqPrimeiro = Number(primeiro.codigo.split("-")[1]);
      const seqSegundo = Number(segundo.codigo.split("-")[1]);
      expect(seqSegundo).toBe(seqPrimeiro + 1);
    });

    it("rejeita fim anterior ao início", async () => {
      await expect(
        service.criar(payloadCampanha("C", { inicio: "2026-06-01", fim: "2026-01-01" }), null),
      ).rejects.toThrow(ApiException);
    });

    it("descarta fotoDestaque quando destaque=false", async () => {
      const campanha = await service.criar(payloadCampanha("D", { destaque: false, fotoDestaque: "https://x" }), null);
      expect(campanha.fotoDestaque).toBeNull();
    });

    it("preserva fotoDestaque quando destaque=true", async () => {
      const campanha = await service.criar(payloadCampanha("E", { destaque: true, fotoDestaque: "https://x" }), null);
      expect(campanha.fotoDestaque).toBe("https://x");
    });

    it("registra o evento campanha.criada com o usuário autenticado", async () => {
      const campanha = await service.criar(payloadCampanha("F"), "usuario-teste-1");
      const eventos = await connection.collection("eventos_campanha").find({ tipo: "campanha.criada" }).toArray();
      expect(
        eventos.some((item) => String(item["campanhaId"]) === campanha.id && item["usuarioId"] === "usuario-teste-1"),
      ).toBe(true);
    });

    it("nunca repete nem pula código sob criações concorrentes", async () => {
      const chamadas = Array.from({ length: 15 }, (_, indice) => service.criar(payloadCampanha(`CONC-${indice}`), null));
      const campanhas = await Promise.all(chamadas);
      const codigos = new Set(campanhas.map((campanha) => campanha.codigo));
      expect(codigos.size).toBe(15);
    });
  });

  describe("busca, listagem e paginação", () => {
    it("busca uma campanha pelo id", async () => {
      const criada = await service.criar(payloadCampanha("G"), null);
      const encontrada = await service.obterPorId(criada.id);
      expect(encontrada.codigo).toBe(criada.codigo);
    });

    it("lança NOT_FOUND para um id inexistente", async () => {
      await expect(service.obterPorId("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("busca por nome e descrição", async () => {
      const prefixo = `Busca${Date.now()}`;
      await service.criar(payloadCampanha("H", { nome: prefixo, descricao: "Ação de verão" }), null);
      const porNome = await service.listar(queryPadrao({ busca: prefixo }));
      const porDescricao = await service.listar(queryPadrao({ busca: "Ação de verão" }));
      expect(porNome.data).toHaveLength(1);
      expect(porDescricao.data).toHaveLength(1);
    });

    it("pagina corretamente quando há mais registros que o limite", async () => {
      const prefixo = `Pag${Date.now()}`;
      await Promise.all(
        Array.from({ length: 5 }, (_, indice) => service.criar(payloadCampanha(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
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
      await service.criar(payloadCampanha("Z", { nome: `${prefixo} Zulu` }), null);
      await service.criar(payloadCampanha("A", { nome: `${prefixo} Alfa` }), null);
      const asc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "asc" }));
      const desc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "desc" }));
      expect(asc.data[0]?.nome).toContain("Alfa");
      expect(desc.data[0]?.nome).toContain("Zulu");
    });
  });

  describe("situação derivada (facetas)", () => {
    it("filtro situacao=inativa retorna campanhas com ativo=false", async () => {
      const prefixo = `Sit${Date.now()}`;
      await service.criar(payloadCampanha("SIT1", { nome: `${prefixo} 1`, ativo: false }), null);
      await service.criar(payloadCampanha("SIT2", { nome: `${prefixo} 2`, ativo: true }), null);

      const inativas = await service.listar(queryPadrao({ busca: prefixo, situacao: ["inativa"] }));
      expect(inativas.data).toHaveLength(1);
      expect(inativas.data[0]?.ativo).toBe(false);
    });

    it("filtro situacao=agendada retorna campanhas com início no futuro", async () => {
      const prefixo = `Agenda${Date.now()}`;
      const futuro = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const futuroFim = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
      await service.criar(payloadCampanha("AG1", { nome: prefixo, inicio: futuro, fim: futuroFim, ativo: true }), null);

      const agendadas = await service.listar(queryPadrao({ busca: prefixo, situacao: ["agendada"] }));
      expect(agendadas.data).toHaveLength(1);
    });
  });

  describe("agregado de produtos vinculados", () => {
    it("produtosVinculados reflete os produtos ATIVOS vinculados", async () => {
      const campanha = await service.criar(payloadCampanha("AGG"), null);
      await produtosService.criar(payloadProduto("AGG-1", { campanhaId: campanha.id }), null);
      await produtosService.criar(payloadProduto("AGG-2", { campanhaId: campanha.id }), null);
      await produtosService.criar(payloadProduto("AGG-3"), null); // sem campanha — não deve contar

      const atualizada = await service.obterPorId(campanha.id);
      expect(atualizada.produtosVinculados).toBe(2);
    });

    it("filtro produtos=sem só retorna campanhas sem produtos vinculados", async () => {
      const prefixo = `FiltroProd${Date.now()}`;
      const comProduto = await service.criar(payloadCampanha("FP1", { nome: `${prefixo} Com` }), null);
      await service.criar(payloadCampanha("FP2", { nome: `${prefixo} Sem` }), null);
      await produtosService.criar(payloadProduto("FP-produto", { campanhaId: comProduto.id }), null);

      const semProdutos = await service.listar(queryPadrao({ busca: prefixo, produtos: ["sem"] }));
      expect(semProdutos.data).toHaveLength(1);
      expect(semProdutos.data[0]?.nome).toContain("Sem");
    });

    it("facets do grupo destaque contam sobre o conjunto completo, não a página", async () => {
      const prefixo = `FacetCam${Date.now()}`;
      await service.criar(payloadCampanha("FC1", { nome: `${prefixo} 1`, destaque: true }), null);
      await service.criar(payloadCampanha("FC2", { nome: `${prefixo} 2` }), null);
      await service.criar(payloadCampanha("FC3", { nome: `${prefixo} 3` }), null);

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
    it("atualiza os dados da campanha", async () => {
      const criada = await service.criar(payloadCampanha("I"), null);
      const atualizada = await service.atualizar(criada.id, payloadCampanha("I", { nome: "Nome Atualizado" }), null);
      expect(atualizada.nome).toBe("Nome Atualizado");
    });

    it("rejeita atualização com fim anterior ao início", async () => {
      const criada = await service.criar(payloadCampanha("J"), null);
      await expect(
        service.atualizar(criada.id, payloadCampanha("J", { inicio: "2026-06-01", fim: "2026-01-01" }), null),
      ).rejects.toThrow(ApiException);
    });

    it("alterarStatus ativa/inativa a campanha", async () => {
      const criada = await service.criar(payloadCampanha("K", { ativo: true }), null);
      const inativada = await service.alterarStatus(criada.id, { ativo: false }, null);
      expect(inativada.ativo).toBe(false);
      const reativada = await service.alterarStatus(criada.id, { ativo: true }, null);
      expect(reativada.ativo).toBe(true);
    });
  });

  describe("exclusão (soft delete e bloqueio por vínculo)", () => {
    it("some da listagem/detalhe após excluída, mas o documento continua no banco", async () => {
      const criada = await service.criar(payloadCampanha("L"), null);
      await service.excluir(criada.id, null);
      await expect(service.obterPorId(criada.id)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("campanhas").findOne({ codigo: criada.codigo });
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });

    it("não reaproveita o código de uma campanha excluída", async () => {
      const excluida = await service.criar(payloadCampanha("M1"), null);
      await service.excluir(excluida.id, null);
      const nova = await service.criar(payloadCampanha("M2"), null);
      expect(nova.codigo).not.toBe(excluida.codigo);
    });

    it("bloqueia a exclusão quando há produtos ativos vinculados", async () => {
      const campanha = await service.criar(payloadCampanha("N"), null);
      await produtosService.criar(payloadProduto("N-produto", { campanhaId: campanha.id }), null);
      await expect(service.excluir(campanha.id, null)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("campanhas").findOne({ codigo: campanha.codigo });
      expect(bruto?.["excluidoEm"]).toBeNull();
    });
  });

  describe("produtos vinculados (detalhe)", () => {
    it("lista os produtos atualmente vinculados", async () => {
      const campanha = await service.criar(payloadCampanha("O"), null);
      await produtosService.criar(payloadProduto("O-1", { campanhaId: campanha.id }), null);
      await produtosService.criar(payloadProduto("O-2", { campanhaId: campanha.id }), null);
      await produtosService.criar(payloadProduto("O-outro"), null);

      const produtos = await service.listarProdutos(campanha.id);
      expect(produtos).toHaveLength(2);
    });

    it("lança NOT_FOUND para uma campanha inexistente", async () => {
      await expect(service.listarProdutos("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });
  });
});
