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
import { CaixasService } from "../caixas/caixas.service.js";
import type { CriarClienteDto } from "../clientes/dto/criar-cliente.dto.js";
import { ClientesService } from "../clientes/clientes.service.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { CriarVendedorDto } from "../vendedores/dto/criar-vendedor.dto.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { VendasService } from "../vendas/vendas.service.js";
import { PdvVendasModule } from "./pdv-vendas.module.js";
import { PdvVendasService } from "./pdv-vendas.service.js";
import type { CriarVendaPdvDto } from "./dto/criar-venda-pdv.dto.js";

// `VendedoresController`/`ProdutosController`/`CaixasController` (importados
// transitivamente) usam `JwtAuthGuard` do ADMIN via `@UseGuards`, que precisa
// de um `JwtService` GLOBAL para resolver — nada a ver com o PDV.
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

function uuid(): string {
  return `pdv-venda-teste-${Date.now()}-${sufixo()}`;
}

/**
 * Equivalente a `await expect(promise).rejects.toThrow(ApiException)`, mas
 * via try/catch manual — usado neste arquivo porque o matcher `.rejects` do
 * bun:test se mostrou instável (timeout esporádico só ao rodar o arquivo
 * INTEIRO, nunca isoladamente) quando encadeado logo após várias operações
 * reais de MongoDB na mesma suíte (ver "Problemas encontrados" no relatório
 * da Etapa 05 do PDV). O comportamento verificado é idêntico.
 */
async function esperarRejeicao(promessa: Promise<unknown>): Promise<void> {
  let erro: unknown = null;
  try {
    await promessa;
  } catch (capturado) {
    erro = capturado;
  }
  expect(erro).toBeInstanceOf(ApiException);
}

describe("PdvVendasService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: PdvVendasService;
  let vendasService: VendasService;
  let produtosService: ProdutosService;
  let vendedoresService: VendedoresService;
  let clientesService: ClientesService;
  let caixasService: CaixasService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseModuloDeTeste(),
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
        JWT_ADMIN_MODULO_DE_TESTE,
        PdvVendasModule,
      ],
    }).compile();
    service = moduleRef.get(PdvVendasService);
    vendasService = moduleRef.get(VendasService);
    produtosService = moduleRef.get(ProdutosService);
    vendedoresService = moduleRef.get(VendedoresService);
    clientesService = moduleRef.get(ClientesService);
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

  async function criarProdutoComEstoque(precoVenda: number, quantidade: number, extra: Partial<CriarProdutoDto> = {}) {
    const s = sufixo();
    const produto = await produtosService.criar(
      { nome: `Produto PDV Venda ${s}`, categoria: "Vestidos", precoCusto: precoVenda / 2, precoVenda, ehNovidade: false, ...extra },
      null,
    );
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const varianteId = String(variante._id);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, varianteId, {
      tamanho: "M",
      delta: quantidade,
      exigirExistente: false,
    });
    return { produtoId: produto.id, varianteId, tamanhoId, precoVenda };
  }

  async function criarVendedor(ativo = true) {
    const s = sufixo();
    const dto: CriarVendedorDto = { nome: `Vendedor PDV Venda ${s}`, telefone: `1194${String(contador).padStart(6, "0")}`, ativo, senha: "senha123" };
    return vendedoresService.criar(dto, null);
  }

  async function criarCliente() {
    const s = sufixo();
    const dto: CriarClienteDto = { nome: `Cliente PDV Venda ${s}`, telefone: `8392${String(contador).padStart(6, "0")}` };
    return clientesService.criar(dto, null);
  }

  async function abrirCaixa() {
    return caixasService.abrir({ valorInicial: 1000, observacao: "" }, null);
  }

  function payloadPadrao(extra: Partial<CriarVendaPdvDto> & Pick<CriarVendaPdvDto, "itens" | "pagamentos">): CriarVendaPdvDto {
    return { idempotencyKey: uuid(), ...extra };
  }

  describe("caixa resolvido do backend", () => {
    it("sem nenhum caixa aberto, rejeita com erro claro (não cria venda)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();

      await esperarRejeicao(
        service.criar(vendedor.id, payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [] })),
      );
    });

    it("com caixa aberto, a venda é vinculada a ELE (nunca escolhido pelo cliente)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 100 }] }),
      );
      expect(venda.caixaId).toBe(caixa.id);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });
  });

  describe("criação básica", () => {
    it("vendedor da venda é o vendedor autenticado (parâmetro), nunca um valor do payload", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const outroVendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      // Mesmo que o objeto JS "vazasse" um vendedorId (impossível via DTO real,
      // ver forbidNonWhitelisted testado no e2e) — o parâmetro da função é a
      // única fonte usada.
      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 100 }] }),
      );
      expect(venda.vendedorId).toBe(vendedor.id);
      expect(venda.vendedorId).not.toBe(outroVendedor.id);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("sem clienteId, a venda é registrada como Consumidor final", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 100 }] }),
      );
      expect(venda.clienteId).toBeNull();
      expect(venda.clienteNome).toBe("Consumidor final");
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("com clienteId válido, a venda usa o cliente real (nome vindo do banco, não do payload)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ clienteId: cliente.id, itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 100 }] }),
      );
      expect(venda.clienteId).toBe(cliente.id);
      expect(venda.clienteNome).toBe(cliente.nome);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("clienteId inexistente propaga erro do domínio de Vendas (não cria venda)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarRejeicao(
        service.criar(
          vendedor.id,
          payloadPadrao({ clienteId: "65f1a2b3c4d5e6f7a8b9c0d1", itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [] }),
        ),
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("preço e estoque (delegados ao domínio de Vendas — nunca recalculados aqui)", () => {
    it("preço praticado usa a promoção quando ativa (precoEfetivo, não o preço de tabela)", async () => {
      const produto = await criarProdutoComEstoque(200, 5);
      await produtosService.definirPromocao(produto.produtoId, { ehPromocao: true, precoPromocional: 150 }, null);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "PIX", valor: 150 }] }),
      );
      expect(venda.itens[0]?.precoPraticado).toBe(150);
      expect(venda.valorFinal).toBe(150);
      await caixasService.fechar(caixa.id, { valorInformado: 1150 }, null);
    });

    it("estoque é baixado corretamente (confirmado no banco)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await service.criar(
        vendedor.id,
        payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 2 }], pagamentos: [{ forma: "Dinheiro", valor: 200 }] }),
      );

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      const tamanho = atualizado.variantes[0]!.tamanhos.find((t) => String(t._id) === produto.tamanhoId)!;
      expect(tamanho.quantidade).toBe(3);
      await caixasService.fechar(caixa.id, { valorInformado: 1200 }, null);
    });

    it("estoque insuficiente é rejeitado (400) e não baixa nada", async () => {
      const produto = await criarProdutoComEstoque(100, 1);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarRejeicao(
        service.criar(
          vendedor.id,
          payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 5 }], pagamentos: [] }),
        ),
      );

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      expect(atualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(1);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });

    it("produto/variante/tamanho inexistentes são rejeitados", async () => {
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      await esperarRejeicao(
        service.criar(vendedor.id, payloadPadrao({ itens: [{ produtoId: "65f1a2b3c4d5e6f7a8b9c0d1", varianteId: "x", tamanhoId: "y", quantidade: 1 }], pagamentos: [] })),
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("itens duplicados", () => {
    it("rejeita duas linhas apontando para o mesmo produto/variante/tamanho", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarRejeicao(
        service.criar(
          vendedor.id,
          payloadPadrao({
            itens: [
              { produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 },
              { produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 },
            ],
            pagamentos: [],
          }),
        ),
      );

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      expect(atualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(5);
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("desconto", () => {
    it("desconto válido reduz o valor final corretamente", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          descontoVenda: 10,
          pagamentos: [{ forma: "Dinheiro", valor: 90 }],
        }),
      );
      expect(venda.valorBruto).toBe(100);
      expect(venda.descontoVenda).toBe(10);
      expect(venda.valorFinal).toBe(90);
      await caixasService.fechar(caixa.id, { valorInformado: 1090 }, null);
    });

    it("desconto acima do subtotal é rejeitado", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      await esperarRejeicao(
        service.criar(
          vendedor.id,
          payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], descontoVenda: 1000, pagamentos: [] }),
        ),
      );
      await caixasService.fechar(caixa.id, { valorInformado: 1000 }, null);
    });
  });

  describe("pagamento parcial e total", () => {
    it("pagamento parcial: status em_pagamento, caixa recebe só o valor pago, pendente correto", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({
          clienteId: cliente.id,
          itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
          pagamentos: [{ forma: "Dinheiro", valor: 200 }],
        }),
      );
      expect(venda.status).toBe("em_pagamento");
      expect(venda.valorFinal).toBe(500);
      expect(venda.valorPago).toBe(200);
      expect(venda.valorPendente).toBe(300);

      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.totalVendas).toBe(200);
      expect(detalheCaixa.resumo.saldoEsperado).toBe(1200);
      await caixasService.fechar(caixa.id, { valorInformado: 1200 }, null);
    });

    it("pagamento total: status concluida, caixa recebe o valor cheio", async () => {
      const produto = await criarProdutoComEstoque(500, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 500 }] }),
      );
      expect(venda.status).toBe("concluida");
      expect(venda.valorPendente).toBe(0);

      const detalheCaixa = await caixasService.obterDetalhe(caixa.id);
      expect(detalheCaixa.resumo.totalVendas).toBe(500);
      expect(detalheCaixa.resumo.saldoEsperado).toBe(1500);
      await caixasService.fechar(caixa.id, { valorInformado: 1500 }, null);
    });
  });

  describe("movimento de caixa", () => {
    it("registra exatamente um movimento correto (tipo, sentido, valor, caixaId)", async () => {
      const produto = await criarProdutoComEstoque(300, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "PIX", valor: 300 }] }),
      );

      const movimentos = await connection.collection("movimentos_caixa").find({ vendaId: venda.id }).toArray();
      expect(movimentos).toHaveLength(1);
      expect(movimentos[0]!["tipo"]).toBe("venda");
      expect(movimentos[0]!["sentido"]).toBe("entrada");
      expect(movimentos[0]!["valor"]).toBe(300);
      expect(String(movimentos[0]!["caixaId"])).toBe(caixa.id);
      await caixasService.fechar(caixa.id, { valorInformado: 1300 }, null);
    });
  });

  describe("agregados de cliente/vendedor", () => {
    it("atualiza compras/totalComprado/ultimaCompra do cliente e vendas/totalVendido/ultimaVenda do vendedor", async () => {
      const produto = await criarProdutoComEstoque(150, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ clienteId: cliente.id, itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 150 }] }),
      );

      const clienteAtualizado = await clientesService.obterPorId(cliente.id);
      expect(clienteAtualizado.compras).toBe(1);
      expect(clienteAtualizado.totalComprado).toBe(150);
      expect(clienteAtualizado.ultimaCompra?.toISOString()).toBe(venda.dataVenda.toISOString());

      const vendedorAtualizado = await vendedoresService.obterPorId(vendedor.id);
      expect(vendedorAtualizado.vendas).toBe(1);
      expect(vendedorAtualizado.totalVendido).toBe(150);
      await caixasService.fechar(caixa.id, { valorInformado: 1150 }, null);
    });
  });

  describe("snapshot histórico", () => {
    it("alterar o produto depois da venda não muda o histórico já gravado", async () => {
      const produto = await criarProdutoComEstoque(200, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 200 }] }),
      );
      const nomeOriginal = venda.itens[0]!.nome;
      const precoOriginal = venda.itens[0]!.precoPraticado;

      await produtosService.atualizar(produto.produtoId, { nome: "Nome Totalmente Diferente", categoria: "Vestidos", precoCusto: 999, precoVenda: 999 }, null);

      const vendaFresca = await vendasService.obterPorId(venda.id);
      expect(vendaFresca.itens[0]!.nome).toBe(nomeOriginal);
      expect(vendaFresca.itens[0]!.precoPraticado).toBe(precoOriginal);
      expect(vendaFresca.itens[0]!.nome).not.toBe("Nome Totalmente Diferente");
      await caixasService.fechar(caixa.id, { valorInformado: 1200 }, null);
    });
  });

  describe("idempotência", () => {
    it("retry sequencial com a mesma chave devolve a MESMA venda (não duplica)", async () => {
      const produto = await criarProdutoComEstoque(100, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();
      const payload = payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 100 }] });

      const primeira = await service.criar(vendedor.id, payload);
      const segunda = await service.criar(vendedor.id, payload);

      expect(segunda.id).toBe(primeira.id);
      const total = await connection.collection("vendas").countDocuments({ idempotencyKey: payload.idempotencyKey });
      expect(total).toBe(1);

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      expect(atualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(4);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });

    it("duas requisições CONCORRENTES com a mesma chave: uma única venda, uma baixa de estoque, um movimento de caixa, um conjunto de agregados", async () => {
      const produto = await criarProdutoComEstoque(120, 5);
      const vendedor = await criarVendedor();
      const cliente = await criarCliente();
      const caixa = await abrirCaixa();
      const payload = payloadPadrao({
        clienteId: cliente.id,
        itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }],
        pagamentos: [{ forma: "Dinheiro", valor: 120 }],
      });

      const [a, b] = await Promise.all([service.criar(vendedor.id, payload), service.criar(vendedor.id, payload)]);
      expect(a.id).toBe(b.id);

      const totalVendas = await connection.collection("vendas").countDocuments({ idempotencyKey: payload.idempotencyKey });
      expect(totalVendas).toBe(1);

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      expect(atualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(4); // baixou 1, não 2

      const movimentos = await connection.collection("movimentos_caixa").find({ vendaId: a.id }).toArray();
      expect(movimentos).toHaveLength(1);

      const vendedorAtualizado = await vendedoresService.obterPorId(vendedor.id);
      expect(vendedorAtualizado.vendas).toBe(1);
      expect(vendedorAtualizado.totalVendido).toBe(120);

      const clienteAtualizado = await clientesService.obterPorId(cliente.id);
      expect(clienteAtualizado.compras).toBe(1);
      expect(clienteAtualizado.totalComprado).toBe(120);

      await caixasService.fechar(caixa.id, { valorInformado: 1120 }, null);
    });
  });

  describe("concorrência de estoque (chaves diferentes disputando a última unidade)", () => {
    it("duas vendas concorrentes por 1 unidade: uma aprovada, uma rejeitada, estoque final = 0", async () => {
      const produto = await criarProdutoComEstoque(100, 1);
      const vendedorA = await criarVendedor();
      const vendedorB = await criarVendedor();
      const caixa = await abrirCaixa();

      const item = { produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 };
      const resultados = await Promise.allSettled([
        service.criar(vendedorA.id, payloadPadrao({ itens: [item], pagamentos: [{ forma: "Dinheiro", valor: 100 }] })),
        service.criar(vendedorB.id, payloadPadrao({ itens: [item], pagamentos: [{ forma: "Dinheiro", valor: 100 }] })),
      ]);

      const sucesso = resultados.filter((r) => r.status === "fulfilled");
      const falha = resultados.filter((r) => r.status === "rejected");
      expect(sucesso).toHaveLength(1);
      expect(falha).toHaveLength(1);

      const atualizado = await produtosService.obterPorId(produto.produtoId);
      expect(atualizado.variantes[0]!.tamanhos[0]!.quantidade).toBe(0);
      await caixasService.fechar(caixa.id, { valorInformado: 1100 }, null);
    });
  });

  describe("resposta", () => {
    it("contém id, código, status, itens, valores, pagamentos, dataVenda, vendedor, caixa", async () => {
      const produto = await criarProdutoComEstoque(80, 5);
      const vendedor = await criarVendedor();
      const caixa = await abrirCaixa();

      const venda = await service.criar(
        vendedor.id,
        payloadPadrao({ itens: [{ produtoId: produto.produtoId, varianteId: produto.varianteId, tamanhoId: produto.tamanhoId, quantidade: 1 }], pagamentos: [{ forma: "Dinheiro", valor: 80 }] }),
      );

      expect(venda.id).toBeTruthy();
      expect(venda.codigo).toMatch(/^VENDA-\d{4}-\d{2}-\d{2}-\d{4}$/);
      expect(venda.status).toBe("concluida");
      expect(venda.itens).toHaveLength(1);
      expect(venda.valorFinal).toBe(80);
      expect(venda.valorPago).toBe(80);
      expect(venda.valorPendente).toBe(0);
      expect(venda.pagamentos).toHaveLength(1);
      expect(venda.dataVenda).toBeInstanceOf(Date);
      expect(venda.vendedorId).toBe(vendedor.id);
      expect(venda.vendedorNome).toBe(vendedor.nome);
      expect(venda.caixaId).toBe(caixa.id);
      expect(venda.caixaCodigo).toBe(caixa.codigo);
      await caixasService.fechar(caixa.id, { valorInformado: 1080 }, null);
    });
  });
});
