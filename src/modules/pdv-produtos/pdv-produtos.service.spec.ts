import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import configuration from "../../config/configuration.js";
import { validateEnv } from "../../config/env.validation.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { PdvProdutosModule } from "./pdv-produtos.module.js";
import { PdvProdutosService } from "./pdv-produtos.service.js";

// `ProdutosController`/`VendedoresController` (importados transitivamente)
// usam `JwtAuthGuard` do ADMIN via `@UseGuards`, que precisa de um
// `JwtService` GLOBAL para resolver — nada a ver com a autenticação do PDV.
const JWT_ADMIN_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-admin-de-teste",
  signOptions: { expiresIn: "15m" },
});

let contador = 0;
function sufixo(): string {
  contador += 1;
  return String(contador);
}

describe("PdvProdutosService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: PdvProdutosService;
  let produtosService: ProdutosService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseModuloDeTeste(),
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
        JWT_ADMIN_MODULO_DE_TESTE,
        PdvProdutosModule,
      ],
    }).compile();
    service = moduleRef.get(PdvProdutosService);
    produtosService = moduleRef.get(ProdutosService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["produto"] } });
    await moduleRef.close();
  });

  async function criarProduto(extra: Partial<CriarProdutoDto> = {}) {
    const s = sufixo();
    const dto: CriarProdutoDto = {
      nome: `Produto Catálogo PDV ${s}`,
      categoria: "Vestidos",
      precoCusto: 50,
      precoVenda: 150,
      ehNovidade: false,
      ...extra,
    };
    return produtosService.criar(dto, null);
  }

  async function adicionarVarianteComEstoque(produtoId: string, cor: string, tamanhos: { tamanho: string; quantidade: number }[], foto: string | null = null) {
    const variante = await produtosService.adicionarVariante(produtoId, { cor, foto }, null);
    const varianteId = String(variante._id);
    for (const { tamanho, quantidade } of tamanhos) {
      await produtosService.adicionarTamanho(produtoId, varianteId, { tamanho, quantidade }, null);
    }
    return varianteId;
  }

  describe("listar", () => {
    it("produto excluído não aparece no catálogo", async () => {
      const produto = await criarProduto();
      await produtosService.excluir(produto.id, null);

      const resultado = await service.listar({ busca: produto.nome, ordenarPor: "nome", ordem: "asc", page: 1, limit: 30 });
      expect(resultado.data.some((item) => item.id === produto.id)).toBe(false);
    });

    it("produto sem estoque aparece no catálogo marcado como indisponível (nunca escondido)", async () => {
      const produto = await criarProduto();

      const resultado = await service.listar({ busca: produto.nome, ordenarPor: "nome", ordem: "asc", page: 1, limit: 30 });
      const item = resultado.data.find((p) => p.id === produto.id);
      expect(item).toBeDefined();
      expect(item!.quantidadeTotal).toBe(0);
      expect(item!.disponivel).toBe(false);
    });

    it("produto com estoque aparece disponível, com quantidadeTotal correta", async () => {
      const produto = await criarProduto();
      await adicionarVarianteComEstoque(produto.id, "Azul", [{ tamanho: "M", quantidade: 5 }, { tamanho: "G", quantidade: 3 }]);

      const resultado = await service.listar({ busca: produto.nome, ordenarPor: "nome", ordem: "asc", page: 1, limit: 30 });
      const item = resultado.data.find((p) => p.id === produto.id)!;
      expect(item.disponivel).toBe(true);
      expect(item.quantidadeTotal).toBe(8);
      expect(item.variantes).toHaveLength(1);
      expect(item.variantes[0]!.cor).toBe("Azul");
      expect(item.variantes[0]!.quantidade).toBe(8);
      expect(item.variantes[0]!.disponivel).toBe(true);
      const tamanhoM = item.variantes[0]!.tamanhos.find((t) => t.tamanho === "M")!;
      expect(tamanhoM.quantidade).toBe(5);
      expect(tamanhoM.disponivel).toBe(true);
    });

    it("busca por nome é case-insensitive e server-side", async () => {
      const produto = await criarProduto({ nome: `Vestido Midi Catálogo ${sufixo()}` });
      const resultado = await service.listar({ busca: produto.nome.toUpperCase(), ordenarPor: "nome", ordem: "asc", page: 1, limit: 30 });
      expect(resultado.data.some((item) => item.id === produto.id)).toBe(true);
    });

    it("busca por código encontra o produto", async () => {
      const produto = await criarProduto();
      const resultado = await service.listar({ busca: produto.codProduto, ordenarPor: "nome", ordem: "asc", page: 1, limit: 30 });
      expect(resultado.data.some((item) => item.id === produto.id)).toBe(true);
    });

    it("paginação é real (server-side): meta reflete total/página/limite pedidos", async () => {
      const nomeBase = `Paginacao PDV ${sufixo()}`;
      await criarProduto({ nome: `${nomeBase} A` });
      await criarProduto({ nome: `${nomeBase} B` });
      await criarProduto({ nome: `${nomeBase} C` });

      const pagina1 = await service.listar({ busca: nomeBase, ordenarPor: "nome", ordem: "asc", page: 1, limit: 2 });
      expect(pagina1.data).toHaveLength(2);
      expect(pagina1.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });

      const pagina2 = await service.listar({ busca: nomeBase, ordenarPor: "nome", ordem: "asc", page: 2, limit: 2 });
      expect(pagina2.data).toHaveLength(1);
    });

    it("ordenação padrão (nome asc) e ordenação por precoVenda funcionam", async () => {
      const nomeBase = `Ordenacao PDV ${sufixo()}`;
      await criarProduto({ nome: `${nomeBase} Zebra`, precoVenda: 50 });
      await criarProduto({ nome: `${nomeBase} Alfa`, precoVenda: 500 });

      const porNome = await service.listar({ busca: nomeBase, ordenarPor: "nome", ordem: "asc", page: 1, limit: 30 });
      expect(porNome.data[0]!.nome.endsWith("Alfa")).toBe(true);

      const porPreco = await service.listar({ busca: nomeBase, ordenarPor: "precoVenda", ordem: "asc", page: 1, limit: 30 });
      expect(porPreco.data[0]!.precoVenda).toBe(50);
    });

    it("preço efetivo usa precoVenda quando não há promoção, e precoPromocional quando a promoção está ativa", async () => {
      const semPromocao = await criarProduto({ precoVenda: 200 });
      const resultadoSemPromo = await service.listar({ busca: semPromocao.nome, ordenarPor: "nome", ordem: "asc", page: 1, limit: 30 });
      const itemSemPromo = resultadoSemPromo.data.find((p) => p.id === semPromocao.id)!;
      expect(itemSemPromo.precoEfetivo).toBe(200);
      expect(itemSemPromo.ehPromocao).toBe(false);
      expect(itemSemPromo.precoPromocional).toBeNull();

      const comPromocao = await criarProduto({ precoVenda: 200 });
      await produtosService.definirPromocao(comPromocao.id, { ehPromocao: true, precoPromocional: 150 }, null);
      const resultadoComPromo = await service.listar({ busca: comPromocao.nome, ordenarPor: "nome", ordem: "asc", page: 1, limit: 30 });
      const itemComPromo = resultadoComPromo.data.find((p) => p.id === comPromocao.id)!;
      expect(itemComPromo.precoEfetivo).toBe(150);
      expect(itemComPromo.ehPromocao).toBe(true);
      expect(itemComPromo.precoPromocional).toBe(150);
      expect(itemComPromo.precoVenda).toBe(200);
    });

    it("nunca expõe campos administrativos (precoCusto, margemLucro, corNormalizada, fornecedorId, colecaoId, campanhaId)", async () => {
      const produto = await criarProduto({ fornecedorId: "for-1", colecaoId: "col-1", campanhaId: "cam-1" });
      await adicionarVarianteComEstoque(produto.id, "Preto", [{ tamanho: "P", quantidade: 1 }]);

      const resultado = await service.listar({ busca: produto.nome, ordenarPor: "nome", ordem: "asc", page: 1, limit: 30 });
      const item = resultado.data.find((p) => p.id === produto.id)!;
      const bruto = JSON.stringify(item);
      expect(bruto).not.toContain("precoCusto");
      expect(bruto).not.toContain("margemLucro");
      expect(bruto).not.toContain("corNormalizada");
      expect(bruto).not.toContain("fornecedorId");
      expect(bruto).not.toContain("colecaoId");
      expect(bruto).not.toContain("campanhaId");
    });
  });

  describe("obterPorId", () => {
    it("busca direta por id retorna o produto projetado", async () => {
      const produto = await criarProduto();
      await adicionarVarianteComEstoque(produto.id, "Vermelho", [{ tamanho: "U", quantidade: 2 }], "https://exemplo.com/foto.jpg");

      const item = await service.obterPorId(produto.id);
      expect(item.id).toBe(produto.id);
      expect(item.imagem).toBe("https://exemplo.com/foto.jpg");
      expect(item.variantes[0]!.foto).toBe("https://exemplo.com/foto.jpg");
    });

    it("produto inexistente lança erro (404)", async () => {
      await expect(service.obterPorId("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("produto excluído responde como inexistente (404), nunca é retornado", async () => {
      const produto = await criarProduto();
      await produtosService.excluir(produto.id, null);
      await expect(service.obterPorId(produto.id)).rejects.toThrow(ApiException);
    });
  });

  describe("imagem principal", () => {
    it("sem nenhuma variante com foto, imagem é null", async () => {
      const produto = await criarProduto();
      await adicionarVarianteComEstoque(produto.id, "Bege", [{ tamanho: "M", quantidade: 1 }], null);
      const item = await service.obterPorId(produto.id);
      expect(item.imagem).toBeNull();
    });

    it("sem fotoPrincipalVarianteId definido, usa a primeira variante com foto", async () => {
      const produto = await criarProduto();
      await adicionarVarianteComEstoque(produto.id, "Verde", [{ tamanho: "M", quantidade: 1 }], "https://exemplo.com/verde.jpg");
      await adicionarVarianteComEstoque(produto.id, "Rosa", [{ tamanho: "M", quantidade: 1 }], "https://exemplo.com/rosa.jpg");

      const item = await service.obterPorId(produto.id);
      expect(item.imagem).toBe("https://exemplo.com/verde.jpg");
    });

    it("com fotoPrincipalVarianteId definido, usa a foto dessa variante especificamente", async () => {
      const produto = await criarProduto();
      await adicionarVarianteComEstoque(produto.id, "Verde", [{ tamanho: "M", quantidade: 1 }], "https://exemplo.com/verde.jpg");
      const varianteRosaId = await adicionarVarianteComEstoque(produto.id, "Rosa", [{ tamanho: "M", quantidade: 1 }], "https://exemplo.com/rosa.jpg");
      await produtosService.definirFotoPrincipal(produto.id, { varianteId: varianteRosaId }, null);

      const item = await service.obterPorId(produto.id);
      expect(item.imagem).toBe("https://exemplo.com/rosa.jpg");
    });
  });
});
