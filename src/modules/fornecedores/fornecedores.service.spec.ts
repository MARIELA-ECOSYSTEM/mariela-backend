import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { CriarFornecedorDto } from "./dto/criar-fornecedor.dto.js";
import type { ListarFornecedoresQueryDto } from "./dto/listar-fornecedores-query.dto.js";
import { FornecedoresModule } from "./fornecedores.module.js";
import { FornecedoresService } from "./fornecedores.service.js";

// `FornecedoresController` usa `@UseGuards(JwtAuthGuard)`, que injeta
// `JwtService` — só disponível globalmente via `AppModule` de verdade. Este
// teste foca no service, então basta um `JwtModule` local mínimo.
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

let contadorTelefone = 0;
function telefoneUnico(): string {
  contadorTelefone += 1;
  return `1198${String(contadorTelefone).padStart(6, "0")}`;
}

function payloadFornecedor(sufixo: string, extra: Partial<CriarFornecedorDto> = {}): CriarFornecedorDto {
  return { nome: `Fornecedor Teste ${sufixo}`, ...extra };
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

function queryPadrao(extra: Partial<ListarFornecedoresQueryDto> = {}): ListarFornecedoresQueryDto {
  return {
    ordenarPor: "nome",
    ordem: "asc",
    produtos: [],
    endereco: [],
    entrada: [],
    documento: [],
    page: 1,
    limit: 20,
    ...extra,
  };
}

describe("FornecedoresService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: FornecedoresService;
  let produtosService: ProdutosService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, FornecedoresModule],
    }).compile();
    service = moduleRef.get(FornecedoresService);
    produtosService = moduleRef.get(ProdutosService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("fornecedores").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["fornecedor", "produto"] } });
    await connection.collection("eventos_fornecedor").deleteMany({});
    await moduleRef.close();
  });

  describe("criação e código", () => {
    it("cria um fornecedor com código sequencial gerado pelo backend e agregados zerados", async () => {
      const fornecedor = await service.criar(payloadFornecedor("A"), null);
      expect(fornecedor.codigo).toMatch(/^FOR-\d{4}$/);
      expect(fornecedor.produtosVinculados).toBe(0);
      expect(fornecedor.valorEmCusto).toBe(0);
      expect(fornecedor.ultimaEntrada).toBeNull();
    });

    it("gera códigos distintos e sequenciais para fornecedores sucessivos", async () => {
      const primeiro = await service.criar(payloadFornecedor("B1"), null);
      const segundo = await service.criar(payloadFornecedor("B2"), null);
      const seqPrimeiro = Number(primeiro.codigo.split("-")[1]);
      const seqSegundo = Number(segundo.codigo.split("-")[1]);
      expect(seqSegundo).toBe(seqPrimeiro + 1);
    });

    it("aceita fornecedor sem telefone, contato, email, cnpj e instagram", async () => {
      const fornecedor = await service.criar(payloadFornecedor("C"), null);
      expect(fornecedor.telefone).toBe("");
      expect(fornecedor.contato).toBe("");
      expect(fornecedor.email).toBe("");
      expect(fornecedor.cnpj).toBe("");
    });

    it("colapsa endereço 100% vazio para null", async () => {
      const fornecedor = await service.criar(payloadFornecedor("D", { endereco: {} }), null);
      expect(fornecedor.endereco).toBeNull();
    });

    it("preserva endereço parcialmente preenchido", async () => {
      const fornecedor = await service.criar(payloadFornecedor("E", { endereco: { cidade: "Recife", estado: "pe" } }), null);
      expect(fornecedor.endereco?.cidade).toBe("Recife");
      expect(fornecedor.endereco?.estado).toBe("PE");
    });

    it("registra o evento fornecedor.criado com o usuário autenticado", async () => {
      const fornecedor = await service.criar(payloadFornecedor("F"), "usuario-teste-1");
      const eventos = await connection.collection("eventos_fornecedor").find({ tipo: "fornecedor.criado" }).toArray();
      expect(
        eventos.some((item) => String(item["fornecedorId"]) === fornecedor.id && item["usuarioId"] === "usuario-teste-1"),
      ).toBe(true);
    });

    it("nunca repete nem pula código sob criações concorrentes", async () => {
      const chamadas = Array.from({ length: 15 }, (_, indice) => service.criar(payloadFornecedor(`CONC-${indice}`), null));
      const fornecedores = await Promise.all(chamadas);
      const codigos = new Set(fornecedores.map((fornecedor) => fornecedor.codigo));
      expect(codigos.size).toBe(15);
    });
  });

  describe("duplicidade de telefone", () => {
    it("permite múltiplos fornecedores sem telefone", async () => {
      const a = await service.criar(payloadFornecedor("G1"), null);
      const b = await service.criar(payloadFornecedor("G2"), null);
      expect(a.telefone).toBe("");
      expect(b.telefone).toBe("");
    });

    it("rejeita cadastrar duas vezes o mesmo telefone", async () => {
      const telefone = telefoneUnico();
      await service.criar(payloadFornecedor("H1", { telefone }), null);
      await expect(service.criar(payloadFornecedor("H2", { telefone }), null)).rejects.toThrow(ApiException);
    });

    it("permite manter o próprio telefone ao atualizar", async () => {
      const telefone = telefoneUnico();
      const fornecedor = await service.criar(payloadFornecedor("I", { telefone }), null);
      const atualizado = await service.atualizar(fornecedor.id, payloadFornecedor("I", { telefone }), null);
      expect(atualizado.telefone).toBe(telefone);
    });
  });

  describe("busca, listagem e paginação", () => {
    it("busca um fornecedor pelo id", async () => {
      const criado = await service.criar(payloadFornecedor("J"), null);
      const encontrado = await service.obterPorId(criado.id);
      expect(encontrado.codigo).toBe(criado.codigo);
    });

    it("lança NOT_FOUND para um id inexistente", async () => {
      await expect(service.obterPorId("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("busca por nome, contato, telefone e cnpj", async () => {
      const prefixo = `Busca${Date.now()}`;
      const telefone = telefoneUnico();
      await service.criar(payloadFornecedor("K", { nome: prefixo, telefone, cnpj: "11.222.333/0001-44" }), null);

      const porNome = await service.listar(queryPadrao({ busca: prefixo }));
      const porTelefone = await service.listar(queryPadrao({ busca: telefone }));
      const porCnpj = await service.listar(queryPadrao({ busca: "11.222.333" }));
      expect(porNome.data).toHaveLength(1);
      expect(porTelefone.data).toHaveLength(1);
      expect(porCnpj.data).toHaveLength(1);
    });

    it("pagina corretamente quando há mais registros que o limite", async () => {
      const prefixo = `Pag${Date.now()}`;
      await Promise.all(
        Array.from({ length: 5 }, (_, indice) => service.criar(payloadFornecedor(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
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
      await service.criar(payloadFornecedor("Z", { nome: `${prefixo} Zulu` }), null);
      await service.criar(payloadFornecedor("A", { nome: `${prefixo} Alfa` }), null);
      const asc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "asc" }));
      const desc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "desc" }));
      expect(asc.data[0]?.nome).toContain("Alfa");
      expect(desc.data[0]?.nome).toContain("Zulu");
    });
  });

  describe("agregados comerciais (calculados a partir de Produtos)", () => {
    it("produtosVinculados/valorEmCusto/ultimaEntrada refletem os produtos ATIVOS vinculados", async () => {
      const fornecedor = await service.criar(payloadFornecedor("AGG"), null);
      await produtosService.criar(payloadProduto("AGG-1", { fornecedorId: fornecedor.id, precoCusto: 10 }), null);
      const produto2 = await produtosService.criar(payloadProduto("AGG-2", { fornecedorId: fornecedor.id, precoCusto: 20 }), null);
      // produto de outro fornecedor não deve contar
      await produtosService.criar(payloadProduto("AGG-3"), null);

      await produtosService.adicionarVariante(produto2.id, { cor: "Preto" }, null);
      const variante = (await produtosService.obterPorId(produto2.id)).variantes[0]!;
      await produtosService.adicionarTamanho(produto2.id, String(variante._id), { tamanho: "M", quantidade: 3 }, null);

      const atualizado = await service.obterPorId(fornecedor.id);
      expect(atualizado.produtosVinculados).toBe(2);
      // produto1: 10*0 + produto2: 20*3 = 60
      expect(atualizado.valorEmCusto).toBe(60);
      expect(atualizado.ultimaEntrada).not.toBeNull();
    });

    it("filtro produtos=sem só retorna fornecedores sem produtos vinculados", async () => {
      const prefixo = `Filtro${Date.now()}`;
      const comProduto = await service.criar(payloadFornecedor("FP1", { nome: `${prefixo} Com` }), null);
      await service.criar(payloadFornecedor("FP2", { nome: `${prefixo} Sem` }), null);
      await produtosService.criar(payloadProduto("FP-produto", { fornecedorId: comProduto.id }), null);

      const semProdutos = await service.listar(queryPadrao({ busca: prefixo, produtos: ["sem"] }));
      expect(semProdutos.data).toHaveLength(1);
      expect(semProdutos.data[0]?.nome).toContain("Sem");
    });

    it("facets do grupo documento contam sobre o conjunto completo, não a página", async () => {
      const prefixo = `FacetFor${Date.now()}`;
      await service.criar(payloadFornecedor("FF1", { nome: `${prefixo} 1`, cnpj: "00.000.000/0001-00" }), null);
      await service.criar(payloadFornecedor("FF2", { nome: `${prefixo} 2` }), null);
      await service.criar(payloadFornecedor("FF3", { nome: `${prefixo} 3` }), null);

      const resultado = await service.listar(queryPadrao({ busca: prefixo, limit: 1 }));
      expect(resultado.data).toHaveLength(1);
      const documento = resultado.facets["documento"] ?? [];
      const com = documento.find((opcao) => opcao.valor === "com")?.count ?? 0;
      const sem = documento.find((opcao) => opcao.valor === "sem")?.count ?? 0;
      expect(com).toBe(1);
      expect(sem).toBe(2);
    });
  });

  describe("exclusão (soft delete e bloqueio por vínculo)", () => {
    it("some da listagem/detalhe após excluído, mas o documento continua no banco", async () => {
      const criado = await service.criar(payloadFornecedor("L"), null);
      await service.excluir(criado.id, null);
      await expect(service.obterPorId(criado.id)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("fornecedores").findOne({ codigo: criado.codigo });
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });

    it("não reaproveita o código de um fornecedor excluído", async () => {
      const excluido = await service.criar(payloadFornecedor("M1"), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadFornecedor("M2"), null);
      expect(novo.codigo).not.toBe(excluido.codigo);
    });

    it("permite recadastrar o telefone de um fornecedor já excluído", async () => {
      const telefone = telefoneUnico();
      const excluido = await service.criar(payloadFornecedor("N1", { telefone }), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadFornecedor("N2", { telefone }), null);
      expect(novo.telefone).toBe(telefone);
    });

    it("bloqueia a exclusão quando há produtos ativos vinculados", async () => {
      const fornecedor = await service.criar(payloadFornecedor("O"), null);
      await produtosService.criar(payloadProduto("O-produto", { fornecedorId: fornecedor.id }), null);
      await expect(service.excluir(fornecedor.id, null)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("fornecedores").findOne({ codigo: fornecedor.codigo });
      expect(bruto?.["excluidoEm"]).toBeNull();
    });
  });

  describe("histórico de produtos vinculados", () => {
    it("lista os produtos atualmente vinculados, mais recentes primeiro", async () => {
      const fornecedor = await service.criar(payloadFornecedor("P"), null);
      const produto1 = await produtosService.criar(payloadProduto("P-1", { fornecedorId: fornecedor.id }), null);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const produto2 = await produtosService.criar(payloadProduto("P-2", { fornecedorId: fornecedor.id }), null);

      const historico = await service.listarHistorico(fornecedor.id);
      expect(historico).toHaveLength(2);
      expect(historico.every((item) => item.situacao === "atual")).toBe(true);
      expect(historico.every((item) => item.desvinculadoEm === null)).toBe(true);
      expect(historico[0]?.produtoId).toBe(produto2.id);
      expect(historico[1]?.produtoId).toBe(produto1.id);
    });

    it("lança NOT_FOUND para um fornecedor inexistente", async () => {
      await expect(service.listarHistorico("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });
  });
});
