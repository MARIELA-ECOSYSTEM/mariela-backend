import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Connection } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendasService } from "../vendas/vendas.service.js";
import { VendasModule } from "../vendas/vendas.module.js";
import type { CriarVendedorDto } from "../vendedores/dto/criar-vendedor.dto.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import type { CriarClienteDto } from "./dto/criar-cliente.dto.js";
import type { ListarClientesQueryDto } from "./dto/listar-clientes-query.dto.js";
import { ClientesModule } from "./clientes.module.js";
import { ClientesService } from "./clientes.service.js";

// `ClientesController` usa `@UseGuards(JwtAuthGuard)`, que injeta `JwtService`
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
  return `8300${String(contadorTelefone).padStart(6, "0")}`;
}

function payloadCliente(sufixo: string, extra: Partial<CriarClienteDto> = {}): CriarClienteDto {
  return {
    nome: `Cliente Teste ${sufixo}`,
    telefone: telefoneUnico(),
    ...extra,
  };
}

function queryPadrao(extra: Partial<ListarClientesQueryDto> = {}): ListarClientesQueryDto {
  return {
    ordenarPor: "nome",
    ordem: "asc",
    recencia: [],
    historico: [],
    aniversario: [],
    observacao: [],
    page: 1,
    limit: 20,
    ...extra,
  };
}

describe("ClientesService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: ClientesService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, ClientesModule],
    }).compile();
    service = moduleRef.get(ClientesService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("clientes").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: "cliente" });
    await connection.collection("eventos_cliente").deleteMany({});
    await moduleRef.close();
  });

  describe("criação e código", () => {
    it("cria um cliente com código sequencial gerado pelo backend e agregados zerados", async () => {
      const cliente = await service.criar(payloadCliente("A"), null);
      expect(cliente.codigo).toMatch(/^CLI-\d{4}$/);
      expect(cliente.compras).toBe(0);
      expect(cliente.totalComprado).toBe(0);
      expect(cliente.ultimaCompra).toBeNull();
    });

    it("gera códigos distintos e sequenciais para clientes sucessivos", async () => {
      const primeiro = await service.criar(payloadCliente("B1"), null);
      const segundo = await service.criar(payloadCliente("B2"), null);
      const seqPrimeiro = Number(primeiro.codigo.split("-")[1]);
      const seqSegundo = Number(segundo.codigo.split("-")[1]);
      expect(seqSegundo).toBe(seqPrimeiro + 1);
    });

    it("preserva a máscara do telefone exibida, mas normaliza internamente para checar duplicidade", async () => {
      const cliente = await service.criar(payloadCliente("C", { telefone: "(83) 90000-0001" }), null);
      expect(cliente.telefone).toBe("(83) 90000-0001");
    });

    it("rejeita telefone com quantidade de dígitos inválida", async () => {
      await expect(service.criar(payloadCliente("D", { telefone: "123" }), null)).rejects.toThrow(ApiException);
    });

    it("registra o evento cliente.criado com o usuário autenticado", async () => {
      const cliente = await service.criar(payloadCliente("E"), "usuario-teste-1");
      const eventos = await connection.collection("eventos_cliente").find({ tipo: "cliente.criado" }).toArray();
      expect(
        eventos.some((item) => String(item["clienteId"]) === cliente.id && item["usuarioId"] === "usuario-teste-1"),
      ).toBe(true);
    });

    it("nunca repete nem pula código sob criações concorrentes", async () => {
      const chamadas = Array.from({ length: 15 }, (_, indice) => service.criar(payloadCliente(`CONC-${indice}`), null));
      const clientes = await Promise.all(chamadas);
      const codigos = new Set(clientes.map((cliente) => cliente.codigo));
      expect(codigos.size).toBe(15);
    });
  });

  describe("duplicidade de telefone", () => {
    it("rejeita cadastrar duas vezes o mesmo telefone (mesma máscara)", async () => {
      const telefone = telefoneUnico();
      await service.criar(payloadCliente("F1", { telefone }), null);
      await expect(service.criar(payloadCliente("F2", { telefone }), null)).rejects.toThrow(ApiException);
    });

    it("rejeita o mesmo telefone com máscara diferente", async () => {
      const digitos = telefoneUnico();
      await service.criar(payloadCliente("G1", { telefone: digitos }), null);
      const mascarado = `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
      await expect(service.criar(payloadCliente("G2", { telefone: mascarado }), null)).rejects.toThrow(ApiException);
    });

    it("permite manter o próprio telefone ao atualizar (não conflita consigo mesmo)", async () => {
      const cliente = await service.criar(payloadCliente("H"), null);
      const atualizado = await service.atualizar(cliente.id, payloadCliente("H", { telefone: cliente.telefone }), null);
      expect(atualizado.telefone).toBe(cliente.telefone);
    });
  });

  describe("busca e listagem", () => {
    it("busca um cliente pelo id", async () => {
      const criado = await service.criar(payloadCliente("I"), null);
      const encontrado = await service.obterPorId(criado.id);
      expect(encontrado.codigo).toBe(criado.codigo);
    });

    it("lança NOT_FOUND para um id inexistente", async () => {
      await expect(service.obterPorId("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("lista clientes com paginação e meta", async () => {
      const nomeUnico = `Listagem ${Date.now()}`;
      await service.criar(payloadCliente("J", { nome: nomeUnico }), null);
      const resultado = await service.listar(queryPadrao({ busca: nomeUnico }));
      expect(resultado.data).toHaveLength(1);
      expect(resultado.meta.total).toBe(1);
      expect(resultado.meta.page).toBe(1);
      expect(resultado.meta.totalPages).toBe(1);
    });

    it("busca por telefone também encontra o cliente", async () => {
      const telefone = telefoneUnico();
      await service.criar(payloadCliente("K", { telefone }), null);
      const resultado = await service.listar(queryPadrao({ busca: telefone }));
      expect(resultado.data).toHaveLength(1);
    });

    it("pagina corretamente quando há mais registros que o limite", async () => {
      const prefixo = `Pag${Date.now()}`;
      await Promise.all(
        Array.from({ length: 5 }, (_, indice) => service.criar(payloadCliente(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
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
      await service.criar(payloadCliente("Z", { nome: `${prefixo} Zulu` }), null);
      await service.criar(payloadCliente("A", { nome: `${prefixo} Alfa` }), null);
      const asc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "asc" }));
      const desc = await service.listar(queryPadrao({ busca: prefixo, ordenarPor: "nome", ordem: "desc" }));
      expect(asc.data[0]?.nome).toContain("Alfa");
      expect(desc.data[0]?.nome).toContain("Zulu");
    });
  });

  describe("filtros (facetas)", () => {
    it("filtro observacao=com só retorna clientes com observação preenchida", async () => {
      const prefixo = `Obs${Date.now()}`;
      await service.criar(payloadCliente("com-obs", { nome: `${prefixo} Com`, observacao: "Gosta de vestidos longos." }), null);
      await service.criar(payloadCliente("sem-obs", { nome: `${prefixo} Sem` }), null);

      const comObservacao = await service.listar(queryPadrao({ busca: prefixo, observacao: ["com"] }));
      expect(comObservacao.data).toHaveLength(1);
      expect(comObservacao.data[0]?.observacao).toContain("vestidos");
    });

    it("filtro historico=sem retorna clientes sem nenhuma compra (todos, hoje)", async () => {
      const prefixo = `Hist${Date.now()}`;
      await service.criar(payloadCliente("hist", { nome: prefixo }), null);
      const resultado = await service.listar(queryPadrao({ busca: prefixo, historico: ["sem"] }));
      expect(resultado.data).toHaveLength(1);
    });

    it("filtro historico=com não retorna clientes sem nenhuma compra registrada", async () => {
      const prefixo = `HistCom${Date.now()}`;
      await service.criar(payloadCliente("histcom", { nome: prefixo }), null);
      const resultado = await service.listar(queryPadrao({ busca: prefixo, historico: ["com"] }));
      expect(resultado.data).toHaveLength(0);
    });

    it("filtro aniversario=com só retorna clientes com data de nascimento cadastrada", async () => {
      const prefixo = `Aniv${Date.now()}`;
      await service.criar(payloadCliente("com-data", { nome: `${prefixo} Com`, dataNascimento: "1998-05-20" }), null);
      await service.criar(payloadCliente("sem-data", { nome: `${prefixo} Sem` }), null);

      const comData = await service.listar(queryPadrao({ busca: prefixo, aniversario: ["com"] }));
      expect(comData.data).toHaveLength(1);
      expect(comData.data[0]?.nome).toContain("Com");
    });

    it("facets do grupo observacao contam sobre o conjunto completo, não a página", async () => {
      const prefixo = `Facet${Date.now()}`;
      await service.criar(payloadCliente("f1", { nome: `${prefixo} 1`, observacao: "Nota" }), null);
      await service.criar(payloadCliente("f2", { nome: `${prefixo} 2` }), null);
      await service.criar(payloadCliente("f3", { nome: `${prefixo} 3` }), null);

      const resultado = await service.listar(queryPadrao({ busca: prefixo, limit: 1 }));
      expect(resultado.data).toHaveLength(1); // página pequena...
      const observacao = resultado.facets["observacao"] ?? [];
      const com = observacao.find((opcao) => opcao.valor === "com")?.count ?? 0;
      const sem = observacao.find((opcao) => opcao.valor === "sem")?.count ?? 0;
      expect(com).toBe(1); // ...mas o facet reflete as 3 clientes da busca, não só a página de 1
      expect(sem).toBe(2);
    });
  });

  describe("atualização", () => {
    it("atualiza os dados cadastrais do cliente", async () => {
      const criado = await service.criar(payloadCliente("L"), null);
      const atualizado = await service.atualizar(criado.id, payloadCliente("L", { nome: "Nome Atualizado", telefone: criado.telefone }), null);
      expect(atualizado.nome).toBe("Nome Atualizado");
    });

    it("lança NOT_FOUND ao atualizar um cliente inexistente", async () => {
      await expect(
        service.atualizar("65f1a2b3c4d5e6f7a8b9c0d1", payloadCliente("M"), null),
      ).rejects.toThrow(ApiException);
    });
  });

  describe("exclusão (soft delete)", () => {
    it("some da listagem/detalhe após excluído, mas o documento continua no banco", async () => {
      const criado = await service.criar(payloadCliente("N"), null);
      await service.excluir(criado.id, null);
      await expect(service.obterPorId(criado.id)).rejects.toThrow(ApiException);

      const bruto = await connection.collection("clientes").findOne({ codigo: criado.codigo });
      expect(bruto?.["excluidoEm"]).not.toBeNull();
    });

    it("não reaproveita o código de um cliente excluído", async () => {
      const excluido = await service.criar(payloadCliente("O1"), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadCliente("O2"), null);
      expect(novo.codigo).not.toBe(excluido.codigo);
    });

    it("permite recadastrar o telefone de um cliente já excluído", async () => {
      const telefone = telefoneUnico();
      const excluido = await service.criar(payloadCliente("P1", { telefone }), null);
      await service.excluir(excluido.id, null);
      const novo = await service.criar(payloadCliente("P2", { telefone }), null);
      expect(novo.telefone).toBe(telefone);
    });
  });

  describe("histórico de vendas: cliente sem nenhuma venda", () => {
    it("devolve lista vazia para um cliente existente sem vendas", async () => {
      const cliente = await service.criar(payloadCliente("Q"), null);
      const vendas = await service.listarVendas(cliente.id);
      expect(vendas.data).toEqual([]);
      expect(vendas.meta.total).toBe(0);
    });

    it("lança NOT_FOUND para um cliente inexistente", async () => {
      await expect(service.listarVendas("65f1a2b3c4d5e6f7a8b9c0d1")).rejects.toThrow(ApiException);
    });

    it("lança NOT_FOUND para um cliente soft-deleted (mesma regra de obterPorId)", async () => {
      const cliente = await service.criar(payloadCliente("Q2"), null);
      await service.excluir(cliente.id, null);
      await expect(service.listarVendas(cliente.id)).rejects.toThrow(ApiException);
    });
  });

  describe("listagem completa sem paginação (contrato legado do Backoffice — Etapa 13.2)", () => {
    it("listarTodosAtivos() devolve todos os clientes ativos, sem truncar por um limite padrão", async () => {
      const prefixo = `Full${Date.now()}`;
      await Promise.all(
        Array.from({ length: 25 }, (_, indice) => service.criar(payloadCliente(`${prefixo}-${indice}`, { nome: `${prefixo} ${indice}` }), null)),
      );
      const todos = await service.listarTodosAtivos();
      const doPrefixo = todos.filter((cliente) => cliente.nome.startsWith(prefixo));
      expect(doPrefixo).toHaveLength(25); // nunca truncado em 20 (LIMITE_PADRAO), ao contrário de listar()
    });

    it("listarTodosAtivos() nunca inclui clientes excluídos (soft delete)", async () => {
      const ativo = await service.criar(payloadCliente("Vis"), null);
      const excluido = await service.criar(payloadCliente("Inv"), null);
      await service.excluir(excluido.id, null);

      const todos = await service.listarTodosAtivos();
      const ids = todos.map((cliente) => cliente.id);
      expect(ids).toContain(ativo.id);
      expect(ids).not.toContain(excluido.id);
    });
  });

  describe("concorrência na criação: colisão de telefone (Etapa 13.2)", () => {
    it("duas criações concorrentes com o MESMO telefone: exatamente uma sucede, a outra é rejeitada por conflito, nunca dois clientes ativos", async () => {
      const telefone = telefoneUnico();
      const resultados = await Promise.allSettled([
        service.criar(payloadCliente("Corr1", { telefone }), null),
        service.criar(payloadCliente("Corr2", { telefone }), null),
      ]);

      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejeitado = resultados.find((r) => r.status === "rejected");
      expect(rejeitado).toBeDefined();
      expect((rejeitado as PromiseRejectedResult).reason).toBeInstanceOf(ApiException);

      const total = await connection.collection("clientes").countDocuments({ telefoneNormalizado: telefone.replace(/\D/g, ""), excluidoEm: null });
      expect(total).toBe(1); // nunca dois clientes ativos com o mesmo telefone
    });
  });
});

/**
 * Suíte SEPARADA (módulo de teste próprio) porque este cenário precisa de
 * vendas reais persistidas — traz `VendasModule` (que já importa
 * `ProdutosModule`/`VendedoresModule`/`CaixasModule`/`ClientesModule`
 * internamente) para o grafo de DI, mesmo padrão já usado por
 * `dashboard.service.spec.ts` para testar a mesma combinação de módulos.
 * `VendasService` NUNCA é alterado aqui — só usado para preparar o cenário
 * (criar vendas reais) e então exercitar `ClientesService.listarVendas`.
 */
describe("ClientesService.listarVendas — histórico real (Etapa 13.2, integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let clientesService: ClientesService;
  let vendasService: VendasService;
  let produtosService: ProdutosService;
  let vendedoresService: VendedoresService;
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
        ClientesModule,
      ],
    }).compile();
    clientesService = moduleRef.get(ClientesService);
    vendasService = moduleRef.get(VendasService);
    produtosService = moduleRef.get(ProdutosService);
    vendedoresService = moduleRef.get(VendedoresService);
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
    await connection.collection("clientes").deleteMany({});
    await connection.collection("eventos_cliente").deleteMany({});
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["venda", "produto", "vendedor", "cliente", "caixa"] } });
    await moduleRef.close();
  });

  async function criarProdutoComEstoque(quantidade: number) {
    const s = sufixo();
    const produto = await produtosService.criar({ nome: `Produto Histórico ${s}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false }, null);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), { tamanho: "M", delta: quantidade, exigirExistente: false });
    return { produtoId: produto.id, varianteId: String(variante._id), tamanhoId };
  }

  async function criarVendedor() {
    const s = sufixo();
    const dto: CriarVendedorDto = { nome: `Vendedor Histórico ${s}`, telefone: `1197${String(contador).padStart(6, "0")}`, ativo: true, senha: "senha123" };
    return vendedoresService.criar(dto, null);
  }

  async function criarCliente() {
    const s = sufixo();
    return clientesService.criar({ nome: `Cliente Histórico ${s}`, telefone: `8392${String(contador).padStart(6, "0")}` }, null);
  }

  async function abrirEFecharCaixa(valorFinal: number) {
    const caixa = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
    await caixasService.fechar(caixa.id, { valorInformado: valorFinal }, null);
    return caixa;
  }

  it("cliente sem vendas: lista vazia", async () => {
    const cliente = await criarCliente();
    const resultado = await clientesService.listarVendas(cliente.id);
    expect(resultado.data).toEqual([]);
    expect(resultado.meta.total).toBe(0);
  });

  it("cliente com UMA venda: a venda aparece no histórico, com o formato de VendaResumo", async () => {
    const cliente = await criarCliente();
    const vendedor = await criarVendedor();
    const produto = await criarProdutoComEstoque(5);
    const caixaAberto = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
    const venda = await vendasService.criar(
      {
        clienteId: cliente.id,
        vendedorId: vendedor.id,
        caixaId: caixaAberto.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 100 }],
      },
      null,
    );
    await caixasService.fechar(caixaAberto.id, { valorInformado: 1100 }, null);

    const resultado = await clientesService.listarVendas(cliente.id);
    expect(resultado.data).toHaveLength(1);
    expect(resultado.meta.total).toBe(1);
    const resumo = resultado.data[0]!;
    expect(resumo.id).toBe(venda.id);
    expect(resumo.codigo).toBe(venda.codigo);
    expect(resumo.clienteId).toBe(cliente.id);
    expect(resumo.valorFinal).toBe(venda.valorFinal);
    expect(resumo.status).toBe(venda.status);
    // Nunca expõe detalhe pesado/interno no resumo.
    expect((resumo as Record<string, unknown>)["itens"]).toBeUndefined();
    expect((resumo as Record<string, unknown>)["pagamentos"]).toBeUndefined();
    expect((resumo as Record<string, unknown>)["idempotencyKey"]).toBeUndefined();
  });

  it("cliente com MÚLTIPLAS vendas: todas aparecem", async () => {
    const cliente = await criarCliente();
    const vendedor = await criarVendedor();

    for (let indice = 0; indice < 3; indice += 1) {
      const produto = await criarProdutoComEstoque(5);
      const caixa = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
      await vendasService.criar(
        {
          clienteId: cliente.id,
          vendedorId: vendedor.id,
          caixaId: caixa.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 100 }],
        },
        null,
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    }

    const resultado = await clientesService.listarVendas(cliente.id);
    expect(resultado.data).toHaveLength(3);
    expect(resultado.meta.total).toBe(3);
  });

  it("isolamento: só aparecem vendas DAQUELE cliente, nunca de outro", async () => {
    const clienteA = await criarCliente();
    const clienteB = await criarCliente();
    const vendedor = await criarVendedor();

    const produtoA = await criarProdutoComEstoque(5);
    const caixaA = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
    await vendasService.criar(
      { clienteId: clienteA.id, vendedorId: vendedor.id, caixaId: caixaA.id, itens: [{ produtoId: produtoA.produtoId, varianteId: produtoA.varianteId, tamanhoId: produtoA.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 100 }] },
      null,
    );
    await caixasService.fechar(caixaA.id, { valorInformado: 1100 }, null);

    const resultadoA = await clientesService.listarVendas(clienteA.id);
    const resultadoB = await clientesService.listarVendas(clienteB.id);
    expect(resultadoA.data).toHaveLength(1);
    expect(resultadoB.data).toHaveLength(0);
    expect(resultadoA.data.every((venda) => venda.clienteId === clienteA.id)).toBe(true);
  });

  it("vendas CANCELADAS continuam aparecendo no histórico — nunca apaga histórico", async () => {
    const cliente = await criarCliente();
    const vendedor = await criarVendedor();
    const produto = await criarProdutoComEstoque(5);
    const caixa = await caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
    const venda = await vendasService.criar(
      { clienteId: cliente.id, vendedorId: vendedor.id, caixaId: caixa.id, itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 100 }] },
      null,
    );
    await vendasService.cancelar(venda.id, { tipo: "integral", motivo: "Teste histórico cliente" }, null);
    await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);

    const resultado = await clientesService.listarVendas(cliente.id);
    expect(resultado.data).toHaveLength(1);
    expect(resultado.data[0]?.status).toBe("cancelada");
  });
});
