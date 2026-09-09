import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendasModule } from "../vendas/vendas.module.js";
import { VendasService } from "../vendas/vendas.service.js";
import type { CriarVendedorDto } from "./dto/criar-vendedor.dto.js";
import type { ListarVendedoresQueryDto } from "./dto/listar-vendedores-query.dto.js";
import { VendedoresModule } from "./vendedores.module.js";
import { VendedoresService } from "./vendedores.service.js";

// `VendedoresController` usa `@UseGuards(JwtAuthGuard)`, que injeta `JwtService`
// — só disponível globalmente via `AppModule` de verdade. Este teste foca no
// service (não no HTTP/guard), então basta um `JwtModule` local mínimo para o
// grafo de DI compilar; nenhum token é de fato emitido/validado aqui.
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

let contadorTelefone = 0;
/** Cada chamada gera um telefone novo e válido (10 dígitos) — telefone é único. */
function telefoneUnico(): string {
  contadorTelefone += 1;
  return `1100${String(contadorTelefone).padStart(6, "0")}`;
}

function payloadVendedor(sufixo: string, extra: Partial<CriarVendedorDto> = {}): CriarVendedorDto {
  return {
    nome: `Vendedor Teste ${sufixo}`,
    telefone: telefoneUnico(),
    ativo: true,
    senha: "senha123",
    ...extra,
  };
}

function queryPadrao(extra: Partial<ListarVendedoresQueryDto> = {}): ListarVendedoresQueryDto {
  return {
    ordenarPor: "nome",
    ordem: "asc",
    status: [],
    vendas: [],
    valor: [],
    ultimaVenda: [],
    nascimento: [],
    observacao: [],
    page: 1,
    limit: 20,
    ...extra,
  };
}

describe("VendedoresService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: VendedoresService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, VendedoresModule],
    }).compile();
    service = moduleRef.get(VendedoresService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: "vendedor" });
    await connection.collection("eventos_vendedor").deleteMany({});
    await moduleRef.close();
  });

  describe("criação, código e senha", () => {
    it("cria um vendedor com código sequencial gerado pelo backend e agregados zerados", async () => {
      const vendedor = await service.criar(payloadVendedor("A"), null);
      expect(vendedor.codigo).toMatch(/^VEN-\d{4}$/);
      expect(vendedor.vendas).toBe(0);
      expect(vendedor.totalVendido).toBe(0);
      expect(vendedor.ultimaVenda).toBeNull();
    });

    it("gera códigos distintos e sequenciais para vendedores sucessivos", async () => {
      const primeiro = await service.criar(payloadVendedor("B1"), null);
      const segundo = await service.criar(payloadVendedor("B2"), null);
      const seqPrimeiro = Number(primeiro.codigo.split("-")[1]);
      const seqSegundo = Number(segundo.codigo.split("-")[1]);
      expect(seqSegundo).toBe(seqPrimeiro + 1);
    });

    it("rejeita criação sem senha", async () => {
      const { senha: _senha, ...semSenha } = payloadVendedor("C");
      await expect(service.criar(semSenha as CriarVendedorDto, null)).rejects.toThrow(ApiException);
    });

    it("nunca expõe senha nem senhaHash na resposta pública", async () => {
      const vendedor = await service.criar(payloadVendedor("D"), null);
      const serializado = JSON.parse(JSON.stringify(vendedor)) as Record<string, unknown>;
      expect(serializado["senha"]).toBeUndefined();
      expect(serializado["senhaHash"]).toBeUndefined();
    });

    it("grava um hash argon2id verificável, nunca a senha em texto puro", async () => {
      const vendedor = await service.criar(payloadVendedor("E", { senha: "minhaSenhaSegura" }), null);
      const bruto = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });
      expect(bruto?.["senhaHash"]).not.toBe("minhaSenhaSegura");
      expect(typeof bruto?.["senhaHash"]).toBe("string");
      expect(await Bun.password.verify("minhaSenhaSegura", bruto!["senhaHash"] as string)).toBe(true);
    });

    it("registra o evento vendedor.criado com o usuário autenticado, sem detalhes sensíveis", async () => {
      const vendedor = await service.criar(payloadVendedor("F"), "usuario-teste-1");
      const eventos = await connection.collection("eventos_vendedor").find({ tipo: "vendedor.criado" }).toArray();
      const evento = eventos.find((item) => String(item["vendedorId"]) === vendedor.id);
      expect(evento?.["usuarioId"]).toBe("usuario-teste-1");
      expect(JSON.stringify(evento?.["detalhes"])).not.toContain("senha");
    });

    it("nunca repete nem pula código sob criações concorrentes", async () => {
      const chamadas = Array.from({ length: 15 }, (_, indice) => service.criar(payloadVendedor(`CONC-${indice}`), null));
      const vendedores = await Promise.all(chamadas);
      const codigos = new Set(vendedores.map((vendedor) => vendedor.codigo));
      expect(codigos.size).toBe(15);
    });
  });

  describe("duplicidade de telefone", () => {
    it("rejeita cadastrar duas vezes o mesmo telefone", async () => {
      const telefone = telefoneUnico();
      await service.criar(payloadVendedor("G1", { telefone }), null);
      await expect(service.criar(payloadVendedor("G2", { telefone }), null)).rejects.toThrow(ApiException);
    });

    it("permite manter o próprio telefone ao atualizar", async () => {
      const vendedor = await service.criar(payloadVendedor("H"), null);
      const atualizado = await service.atualizar(vendedor.id, payloadVendedor("H", { telefone: vendedor.telefone }), null);
      expect(atualizado.telefone).toBe(vendedor.telefone);
    });

    it("rejeita telefone com quantidade de dígitos inválida", async () => {
      await expect(service.criar(payloadVendedor("I", { telefone: "123" }), null)).rejects.toThrow(ApiException);
    });
  });

  describe("atualização e senha", () => {
    it("atualiza dados cadastrais sem alterar a senha quando ela não é enviada", async () => {
      const vendedor = await service.criar(payloadVendedor("J", { senha: "senhaOriginal" }), null);
      const antes = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });

      const { senha: _semSenha, ...payloadSemSenha } = payloadVendedor("J", { telefone: vendedor.telefone });
      const atualizado = await service.atualizar(vendedor.id, { ...payloadSemSenha, nome: "Nome Atualizado" } as CriarVendedorDto, null);
      const depois = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });

      expect(atualizado.nome).toBe("Nome Atualizado");
      expect(depois?.["senhaHash"]).toBe(antes?.["senhaHash"]);
    });

    it("substitui a senha quando enviada em atualizar()", async () => {
      const vendedor = await service.criar(payloadVendedor("K", { senha: "senhaAntiga1" }), null);
      await service.atualizar(vendedor.id, payloadVendedor("K", { telefone: vendedor.telefone, senha: "senhaNova12" }), null);
      const bruto = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });
      expect(await Bun.password.verify("senhaNova12", bruto!["senhaHash"] as string)).toBe(true);
    });

    it("lança NOT_FOUND ao atualizar um vendedor inexistente", async () => {
      await expect(service.atualizar("65f1a2b3c4d5e6f7a8b9c0d1", payloadVendedor("L"), null)).rejects.toThrow(ApiException);
    });
  });

  describe("redefinição dedicada de senha", () => {
    it("substitui o hash e registra evento sem senha nos detalhes", async () => {
      const vendedor = await service.criar(payloadVendedor("M", { senha: "senhaInicial1" }), null);
      await service.redefinirSenha(vendedor.id, { senha: "senhaRedefinida1" }, "admin-teste");
      const bruto = await connection.collection("vendedores").findOne({ codigo: vendedor.codigo });
      expect(await Bun.password.verify("senhaRedefinida1", bruto!["senhaHash"] as string)).toBe(true);

      const eventos = await connection.collection("eventos_vendedor").find({ tipo: "vendedor.senha_redefinida" }).toArray();
      const evento = eventos.find((item) => String(item["vendedorId"]) === vendedor.id);
      expect(evento?.["usuarioId"]).toBe("admin-teste");
      expect(JSON.stringify(evento?.["detalhes"] ?? {})).not.toContain("senha");
    });
  });

  describe("status (ativo/inativo)", () => {
    it("inativa e reativa um vendedor", async () => {
      const vendedor = await service.criar(payloadVendedor("N"), null);
      const inativado = await service.alterarStatus(vendedor.id, { ativo: false }, null);
      expect(inativado.ativo).toBe(false);
      const reativado = await service.alterarStatus(vendedor.id, { ativo: true }, null);
      expect(reativado.ativo).toBe(true);
    });
  });

  describe("busca, paginação e ordenação", () => {
    it("lista vendedores com paginação e meta", async () => {
      const nomeUnico = `Listagem ${Date.now()}`;
      await service.criar(payloadVendedor("O", { nome: nomeUnico }), null);
      const resultado = await service.listar(queryPadrao({ busca: nomeUnico }));
      expect(resultado.data).toHaveLength(1);
      expect(resultado.meta.total).toBe(1);
      expect(resultado.meta.page).toBe(1);
      expect(resultado.meta.totalPages).toBe(1);
    });

    it("busca por código e por telefone também encontra o vendedor", async () => {
      const vendedor = await service.criar(payloadVendedor("P"), null);
      const porCodigo = await service.listar(queryPadrao({ busca: vendedor.codigo }));
      expect(porCodigo.data).toHaveLength(1);
      const porTelefone = await service.listar(queryPadrao({ busca: vendedor.telefone }));
      expect(porTelefone.data).toHaveLength(1);
    });

    it("pagina corretamente quando há mais registros que o limite", async () => {
      const prefixo = `Pag${Date.now()}`;
      await Promise.all(
        Array.from({ length: 5 }, (_, indice) => service.criar(payloadVendedor(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
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
      await service.criar(payloadVendedor("Z", { nome: `${prefixo} Zulu` }), null);
      await service.criar(payloadVendedor("A", { nome: `${prefixo} Alfa` }), null);
      const asc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "asc" }));
      const desc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "desc" }));
      expect(asc.data[0]?.nome).toContain("Alfa");
      expect(desc.data[0]?.nome).toContain("Zulu");
    });
  });

  describe("filtros (facetas)", () => {
    it("filtro status=inativos só retorna vendedores inativos", async () => {
      const prefixo = `Status${Date.now()}`;
      await service.criar(payloadVendedor("ativo", { nome: `${prefixo} Ativo` }), null);
      await service.criar(payloadVendedor("inativo", { nome: `${prefixo} Inativo`, ativo: false }), null);

      const inativos = await service.listar(queryPadrao({ busca: prefixo, status: ["inativos"] }));
      expect(inativos.data).toHaveLength(1);
      expect(inativos.data[0]?.ativo).toBe(false);
    });

    it("filtro vendas=sem retorna vendedores recém-criados (agregado vendas=0 até a primeira venda real)", async () => {
      const prefixo = `Vendas${Date.now()}`;
      await service.criar(payloadVendedor("v1", { nome: prefixo }), null);
      const resultado = await service.listar(queryPadrao({ busca: prefixo, vendas: ["sem"] }));
      expect(resultado.data).toHaveLength(1);
    });

    it("filtro vendas=21+ não retorna vendedores com o agregado `vendas` abaixo da faixa", async () => {
      const prefixo = `Vendas21${Date.now()}`;
      await service.criar(payloadVendedor("v2", { nome: prefixo }), null);
      const resultado = await service.listar(queryPadrao({ busca: prefixo, vendas: ["21+"] }));
      expect(resultado.data).toHaveLength(0);
    });

    it("filtro nascimento=com só retorna vendedores com data de nascimento cadastrada", async () => {
      const prefixo = `Nasc${Date.now()}`;
      await service.criar(payloadVendedor("com-data", { nome: `${prefixo} Com`, dataNascimento: "1994-03-12" }), null);
      await service.criar(payloadVendedor("sem-data", { nome: `${prefixo} Sem` }), null);

      const comData = await service.listar(queryPadrao({ busca: prefixo, nascimento: ["com"] }));
      expect(comData.data).toHaveLength(1);
      expect(comData.data[0]?.nome).toContain("Com");
    });

    it("facets do grupo observacao contam sobre o conjunto completo, não a página", async () => {
      const prefixo = `Facet${Date.now()}`;
      await service.criar(payloadVendedor("f1", { nome: `${prefixo} 1`, observacao: "Nota" }), null);
      await service.criar(payloadVendedor("f2", { nome: `${prefixo} 2` }), null);
      await service.criar(payloadVendedor("f3", { nome: `${prefixo} 3` }), null);

      const resultado = await service.listar(queryPadrao({ busca: prefixo, limit: 1 }));
      expect(resultado.data).toHaveLength(1); // página pequena...
      const observacao = resultado.facets["observacao"] ?? [];
      const com = observacao.find((opcao) => opcao.valor === "com")?.count ?? 0;
      const sem = observacao.find((opcao) => opcao.valor === "sem")?.count ?? 0;
      expect(com).toBe(1); // ...mas o facet reflete os 3 vendedores da busca, não só a página de 1
      expect(sem).toBe(2);
    });
  });

  describe("exclusão (soft delete)", () => {
    it("some da listagem/detalhe após excluído, mas o documento continua no banco", async () => {
      const criado = await service.criar(payloadVendedor("Q"), null);
      await service.excluir(criado.id, null);
      await expect(service.obterPorId(criado.id)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("vendedores").findOne({ codigo: criado.codigo });
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });

    it("não reaproveita o código de um vendedor excluído", async () => {
      const excluido = await service.criar(payloadVendedor("R1"), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadVendedor("R2"), null);
      expect(novo.codigo).not.toBe(excluido.codigo);
    });

    it("permite recadastrar o telefone de um vendedor já excluído", async () => {
      const telefone = telefoneUnico();
      const excluido = await service.criar(payloadVendedor("S1", { telefone }), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadVendedor("S2", { telefone }), null);
      expect(novo.telefone).toBe(telefone);
    });
  });

  describe("histórico de vendas: vendedor sem nenhuma venda", () => {
    it("devolve lista vazia para um vendedor existente sem vendas", async () => {
      const vendedor = await service.criar(payloadVendedor("T"), null);
      const vendas = await service.listarVendas(vendedor.id);
      expect(vendas.data).toEqual([]);
      expect(vendas.meta.total).toBe(0);
    });

    it("lança NOT_FOUND para um vendedor inexistente", async () => {
      await expect(service.listarVendas("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("lança NOT_FOUND para um vendedor soft-deleted (mesma regra de obterPorId)", async () => {
      const vendedor = await service.criar(payloadVendedor("T2"), null);
      await service.excluir(vendedor.id, null);
      await expect(service.listarVendas(vendedor.id)).rejects.toThrow(ApiException);
    });
  });

  describe("listagem completa sem paginação (contrato legado do Backoffice — Etapa 17.2)", () => {
    it("listarTodosAtivos() devolve todos os vendedores ativos, sem truncar por um limite padrão", async () => {
      const prefixo = `Full${Date.now()}`;
      await Promise.all(
        Array.from({ length: 25 }, (_, indice) => service.criar(payloadVendedor(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
      );
      const todos = await service.listarTodosAtivos();
      const doPrefixo = todos.filter((vendedor) => vendedor.nome.startsWith(prefixo));
      expect(doPrefixo).toHaveLength(25); // nunca truncado em 20 (LIMITE_PADRAO), ao contrário de listar()
    });

    it("listarTodosAtivos() nunca inclui vendedores excluídos (soft delete)", async () => {
      const ativo = await service.criar(payloadVendedor("Vis"), null);
      const excluido = await service.criar(payloadVendedor("Inv"), null);
      await service.excluir(excluido.id, null);

      const todos = await service.listarTodosAtivos();
      const ids = todos.map((vendedor) => vendedor.id);
      expect(ids).toContain(ativo.id);
      expect(ids).not.toContain(excluido.id);
    });
  });

  describe("concorrência na criação: colisão de telefone (Etapa 17.2)", () => {
    it("duas criações concorrentes com o MESMO telefone: exatamente uma sucede, a outra é rejeitada por conflito, nunca dois vendedores ativos", async () => {
      const telefone = telefoneUnico();
      const resultados = await Promise.allSettled([
        service.criar(payloadVendedor("Corr1", { telefone }), null),
        service.criar(payloadVendedor("Corr2", { telefone }), null),
      ]);

      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejeitado = resultados.find((r) => r.status === "rejected");
      expect(rejeitado).toBeDefined();
      expect((rejeitado as PromiseRejectedResult).reason).toBeInstanceOf(ApiException);

      const total = await connection.collection("vendedores").countDocuments({ telefoneNormalizado: telefone, excluidoEm: null });
      expect(total).toBe(1); // nunca dois vendedores ativos com o mesmo telefone
    });
  });
});

/**
 * Suíte SEPARADA (módulo de teste próprio) porque este cenário precisa de
 * vendas reais persistidas — traz `VendasModule` (que já importa
 * `ProdutosModule`/`VendedoresModule`/`ClientesModule`/`CaixasModule`
 * internamente) para o grafo de DI, mesmo padrão já usado por
 * `clientes.service.spec.ts`/`dashboard.service.spec.ts` para testar a mesma
 * combinação de módulos. `VendasService` NUNCA é alterado aqui — só usado
 * para preparar o cenário (criar vendas reais) e então exercitar
 * `VendedoresService.listarVendas`.
 */
describe("VendedoresService.listarVendas — histórico real (Etapa 17.2, integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let vendedoresService: VendedoresService;
  let vendasService: VendasService;
  let produtosService: ProdutosService;
  let caixasService: CaixasService;
  let connection: Connection;
  let contador = 0;

  function sufixo(): string {
    contador += 1;
    return String(contador);
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseModuloDeTeste(),
        JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } }),
        VendasModule,
        VendedoresModule,
      ],
    }).compile();
    vendedoresService = moduleRef.get(VendedoresService);
    vendasService = moduleRef.get(VendasService);
    produtosService = moduleRef.get(ProdutosService);
    caixasService = moduleRef.get(CaixasService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("vendas").deleteMany({});
    await connection.collection("eventos_venda").deleteMany({});
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["venda", "produto", "vendedor", "caixa"] } });
    await moduleRef.close();
  });

  async function criarProdutoComEstoque(quantidade: number) {
    const s = sufixo();
    const produto = await produtosService.criar({ nome: `Produto Histórico Vendedor ${s}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false }, null);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanho: "M", delta: quantidade, exigirExistente: false });
    return { produtoId: produto.id, varianteId: String(variante._id), tamanhoId };
  }

  async function criarVendedor() {
    const s = sufixo();
    const dto: CriarVendedorDto = { nome: `Vendedor Histórico ${s}`, telefone: `1198${String(contador).padStart(6, "0")}`, ativo: true, senha: "senha123" };
    return vendedoresService.criar(dto, null);
  }

  it("vendedor sem vendas: lista vazia", async () => {
    const vendedor = await criarVendedor();
    const resultado = await vendedoresService.listarVendas(vendedor.id);
    expect(resultado.data).toEqual([]);
    expect(resultado.meta.total).toBe(0);
  });

  it("vendedor com UMA venda: a venda aparece no histórico, com o formato de VendaResumo", async () => {
    const vendedor = await criarVendedor();
    const produto = await criarProdutoComEstoque(5);
    const caixaAberto = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
    const venda = await vendasService.criar(
      {
        vendedorId: vendedor.id,
        caixaId: caixaAberto.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      },
      null,
    );
    await caixasService.fechar(caixaAberto.id, { valorInformado: 1100 }, null);

    const resultado = await vendedoresService.listarVendas(vendedor.id);
    expect(resultado.data).toHaveLength(1);
    expect(resultado.meta.total).toBe(1);
    const resumo = resultado.data[0]!;
    expect(resumo.id).toBe(venda.id);
    expect(resumo.codigo).toBe(venda.codigo);
    expect(resumo.vendedorId).toBe(vendedor.id);
    expect(resumo.valorFinal).toBe(venda.valorFinal);
    expect(resumo.status).toBe(venda.status);
    // Nunca expõe detalhe pesado/interno no resumo.
    expect((resumo as Record<string, unknown>)["itens"]).toBeUndefined();
    expect((resumo as Record<string, unknown>)["pagamentos"]).toBeUndefined();
    expect((resumo as Record<string, unknown>)["idempotencyKey"]).toBeUndefined();
  });

  it("vendedor com MÚLTIPLAS vendas: todas aparecem, e meta.total reflete a quantidade correta", async () => {
    const vendedor = await criarVendedor();

    for (let indice = 0; indice < 3; indice += 1) {
      const produto = await criarProdutoComEstoque(5);
      const caixa = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
      await vendasService.criar(
        {
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    }

    const resultado = await vendedoresService.listarVendas(vendedor.id);
    expect(resultado.data).toHaveLength(3);
    expect(resultado.meta.total).toBe(3);
  });

  it("isolamento: só aparecem vendas DAQUELE vendedor, nunca de outro", async () => {
    const vendedorA = await criarVendedor();
    const vendedorB = await criarVendedor();

    const produtoA = await criarProdutoComEstoque(5);
    const caixaA = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
    await vendasService.criar(
      { vendedorId: vendedorA.id, caixaId: caixaA.id, itens: [{ produtoId: produtoA.produtoId, varianteId: produtoA.varianteId, tamanhoId: produtoA.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 100 }] },
      null,
    );
    await caixasService.fechar(caixaA.id, { valorInformado: 1100 }, null);

    const resultadoA = await vendedoresService.listarVendas(vendedorA.id);
    const resultadoB = await vendedoresService.listarVendas(vendedorB.id);
    expect(resultadoA.data).toHaveLength(1);
    expect(resultadoB.data).toHaveLength(0);
    expect(resultadoA.data.every((venda) => venda.vendedorId === vendedorA.id)).toBe(true);
  });

  it("vendas CANCELADAS continuam aparecendo no histórico — nunca apaga histórico (mesma regra do Cliente)", async () => {
    const vendedor = await criarVendedor();
    const produto = await criarProdutoComEstoque(5);
    const caixa = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
    const venda = await vendasService.criar(
      { vendedorId: vendedor.id, caixaId: caixa.id, itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 100 }] },
      null,
    );
    await vendasService.cancelar(venda.id, { tipo: "integral", motivo: "Teste histórico vendedor" }, null);
    await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);

    const resultado = await vendedoresService.listarVendas(vendedor.id);
    expect(resultado.data).toHaveLength(1);
    expect(resultado.data[0]?.status).toBe("cancelada");
  });
});
