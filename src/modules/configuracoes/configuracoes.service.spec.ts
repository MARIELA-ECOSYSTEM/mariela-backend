import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection, type Model } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { MovimentoCaixa, type MovimentoCaixaDocument } from "../caixas/schemas/movimento-caixa.schema.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { Venda, type VendaDocument } from "../vendas/schemas/venda.schema.js";
import { ConfiguracoesModule } from "./configuracoes.module.js";
import { ConfiguracoesService } from "./configuracoes.service.js";
import type { AtualizarLojaDto } from "./dto/atualizar-loja.dto.js";

let contadorVenda = 0;
/** Documento MÍNIMO válido de Venda, inserido via o próprio Model do Mongoose (defaults do schema aplicados) — usado SÓ para testar os vínculos de forma de pagamento, nunca para exercitar regra de negócio de Vendas (isso é feito em `vendas.service.spec.ts`). */
function dadosVendaMinima(extra: Partial<Venda> = {}): Partial<Venda> {
  contadorVenda += 1;
  const sufixo = `${Date.now()}-${contadorVenda}`;
  return {
    codigo: `VENDA-CONFIG-TESTE-${sufixo}`,
    numero: `9${String(contadorVenda).padStart(5, "0")}`,
    dataVenda: new Date(),
    clienteNome: "Consumidor final",
    vendedorId: "000000000000000000000001",
    vendedorNome: "Vendedora Teste",
    totalItens: 1,
    valorBruto: 100,
    valorFinal: 100,
    formaPagamento: "SemVinculoFormaPagamento",
    ...extra,
  } as Partial<Venda>;
}

function dadosMovimentoMinimo(extra: Partial<MovimentoCaixa> = {}): Partial<MovimentoCaixa> {
  return {
    caixaId: new Types.ObjectId(),
    dataHora: new Date(),
    tipo: "injecao",
    origem: "manual",
    descricao: "Movimento de teste (vínculo de forma de pagamento)",
    formaPagamento: "SemVinculoFormaPagamento",
    valor: 10,
    sentido: "entrada",
    ...extra,
  } as Partial<MovimentoCaixa>;
}

function payloadProduto(sufixo: string, extra: Partial<CriarProdutoDto> = {}): CriarProdutoDto {
  return {
    nome: `Produto Config Teste ${sufixo}`,
    categoria: "Vestidos",
    precoCusto: 50,
    precoVenda: 100,
    ehNovidade: false,
    ...extra,
  };
}

// `ConfiguracoesController` usa `@UseGuards(JwtAuthGuard)`, que injeta
// `JwtService` — só disponível globalmente via `AppModule` de verdade. Este
// teste foca no service, então basta um `JwtModule` local mínimo (mesmo
// padrão de `adquirentes.service.spec.ts`).
const JWT_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-de-teste",
  signOptions: { expiresIn: "15m" },
});

const USUARIO_ID = "64b000000000000000000001";
/** Ator exclusivo dos testes de auditoria: isola os eventos deles dos gerados pelos demais testes do arquivo. */
const USUARIO_AUDITORIA_ID = "64b000000000000000000002";

function lojaValida(extra: Partial<AtualizarLojaDto> = {}): AtualizarLojaDto {
  return {
    nome: "Loja Exemplo",
    logo: "https://exemplo.com/logo.png",
    telefone: "1130000000",
    whatsapp: "11999990000",
    email: "contato@loja.com",
    endereco: { cep: "01310-100", logradouro: "Av. Paulista", numero: "1000", complemento: "", bairro: "Bela Vista", cidade: "São Paulo", estado: "SP" },
    ...extra,
  };
}

describe("ConfiguracoesService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: ConfiguracoesService;
  let produtosService: ProdutosService;
  let connection: Connection;
  let vendaModel: Model<VendaDocument>;
  let movimentoModel: Model<MovimentoCaixaDocument>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, ConfiguracoesModule],
    }).compile();
    service = moduleRef.get(ConfiguracoesService);
    // `ConfiguracoesModule` importa `ProdutosModule` (Fase 54.0, proteção de
    // exclusão) — mesmo grafo de DI, reaproveitado aqui para montar os
    // produtos/variantes de teste da seção de vínculo.
    produtosService = moduleRef.get(ProdutosService);
    connection = moduleRef.get(getConnectionToken());
    // Fase 55.2 — `ConfiguracoesModule` registra os próprios bindings dos
    // models `Venda`/`MovimentoCaixa` (ver o módulo) só para a checagem de
    // vínculo; reaproveitados aqui para montar os documentos mínimos de
    // teste da seção de formaPagamento, sem precisar importar
    // `VendasModule`/`CaixasModule` completos (que arrastariam Produtos/
    // Clientes/Vendedores/Adquirentes só para inserir um documento simples).
    vendaModel = moduleRef.get(getModelToken(Venda.name));
    movimentoModel = moduleRef.get(getModelToken(MovimentoCaixa.name));
  });

  afterAll(async () => {
    await connection.collection("configuracoes").deleteMany({});
    await connection.collection("eventos_configuracao").deleteMany({ usuarioId: { $in: [USUARIO_ID, USUARIO_AUDITORIA_ID] } });
    await connection.collection("produtos").deleteMany({ nome: /^Produto Config Teste / });
    await connection.collection("vendas").deleteMany({ codigo: /^VENDA-CONFIG-TESTE-/ });
    await connection.collection("movimentos_caixa").deleteMany({ descricao: "Movimento de teste (vínculo de forma de pagamento)" });
    await moduleRef.close();
  });

  describe("singleton", () => {
    it("obter() cria o documento na primeira chamada com defaults vazios", async () => {
      // Isolamento (mesmo padrão já usado abaixo em "dez chamadas concorrentes a
      // obter()"): garante um singleton realmente vazio para ESTE teste, em vez de
      // depender de ser literalmente a primeira operação de todo o processo —
      // premissa frágil sob execução randomizada ou com outros arquivos de teste
      // concorrentes que também registram itens em `configuracoes` (ver Fase 55.1,
      // revisão independente).
      await connection.collection("configuracoes").deleteMany({});
      const configuracao = await service.obter();
      expect(configuracao.categorias).toEqual([]);
      expect(configuracao.tamanhos).toEqual([]);
      expect(configuracao.cores).toEqual([]);
      expect(configuracao.formasPagamento).toEqual([]);
      expect(configuracao.loja.nome).toBe("");

      const total = await connection.collection("configuracoes").countDocuments({});
      expect(total).toBe(1); // nunca mais de um documento
    });

    it("chamadas repetidas de obter() sempre devolvem o MESMO documento (nunca cria um segundo)", async () => {
      const primeira = await service.obter();
      const segunda = await service.obter();
      expect(String(primeira._id)).toBe(String(segunda._id));

      const total = await connection.collection("configuracoes").countDocuments({});
      expect(total).toBe(1);
    });

    it("dez chamadas concorrentes a obter() nunca criam mais de um documento", async () => {
      await connection.collection("configuracoes").deleteMany({});
      await Promise.all(Array.from({ length: 10 }, () => service.obter()));
      const total = await connection.collection("configuracoes").countDocuments({});
      expect(total).toBe(1);
    });
  });

  describe("atualizarLoja", () => {
    it("substitui os dados da loja e atualiza atualizadoEm", async () => {
      const antes = await service.obter();
      const antesDoUpdate = antes.atualizadoEm.getTime();
      await new Promise((resolve) => setTimeout(resolve, 5));

      const atualizada = await service.atualizarLoja(lojaValida(), USUARIO_ID);
      expect(atualizada.loja.nome).toBe("Loja Exemplo");
      expect(atualizada.loja.endereco.cidade).toBe("São Paulo");
      expect(atualizada.atualizadoEm.getTime()).toBeGreaterThan(antesDoUpdate);
    });

    it("aplica trim nos campos da loja", async () => {
      const atualizada = await service.atualizarLoja(lojaValida({ nome: "  Loja Com Espaços  " }), USUARIO_ID);
      expect(atualizada.loja.nome).toBe("Loja Com Espaços");
    });

    it("uma segunda atualização substitui a anterior por inteiro", async () => {
      await service.atualizarLoja(lojaValida({ nome: "Primeira" }), USUARIO_ID);
      const segunda = await service.atualizarLoja(lojaValida({ nome: "Segunda" }), USUARIO_ID);
      expect(segunda.loja.nome).toBe("Segunda");

      const total = await connection.collection("configuracoes").countDocuments({});
      expect(total).toBe(1);
    });
  });

  describe("listas: adicionar/remover", () => {
    it("adiciona categoria, tamanho, cor e forma de pagamento", async () => {
      const chave = Date.now();
      const apos1 = await service.adicionarItem("categorias", `Vestidos-${chave}`, USUARIO_ID);
      expect(apos1.categorias).toContain(`Vestidos-${chave}`);

      const apos2 = await service.adicionarItem("tamanhos", `M-${chave}`, USUARIO_ID);
      expect(apos2.tamanhos).toContain(`M-${chave}`);

      const apos3 = await service.adicionarItem("cores", `Azul-${chave}`, USUARIO_ID);
      expect(apos3.cores).toContain(`Azul-${chave}`);

      const apos4 = await service.adicionarItem("formasPagamento", `PIX-${chave}`, USUARIO_ID);
      expect(apos4.formasPagamento).toContain(`PIX-${chave}`);
    });

    it("aplica trim no valor antes de adicionar", async () => {
      const chave = `Trim-${Date.now()}`;
      const resultado = await service.adicionarItem("categorias", `  ${chave}  `, USUARIO_ID);
      expect(resultado.categorias).toContain(chave);
      expect(resultado.categorias).not.toContain(`  ${chave}  `);
    });

    it("rejeita valor vazio (só espaços) com VALIDATION_ERROR", async () => {
      await expect(service.adicionarItem("categorias", "   ", USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("rejeita item duplicado com CONFLICT, nunca duplica na lista", async () => {
      const chave = `Duplicada-${Date.now()}`;
      await service.adicionarItem("cores", chave, USUARIO_ID);
      await expect(service.adicionarItem("cores", chave, USUARIO_ID)).rejects.toThrow(ApiException);

      const configuracao = await service.obter();
      expect(configuracao.cores.filter((item) => item === chave)).toHaveLength(1);
    });

    it("remove item existente", async () => {
      const chave = `Remover-${Date.now()}`;
      await service.adicionarItem("tamanhos", chave, USUARIO_ID);
      const apos = await service.removerItem("tamanhos", chave, USUARIO_ID);
      expect(apos.tamanhos).not.toContain(chave);
    });

    it("rejeita remoção de item inexistente com NOT_FOUND", async () => {
      await expect(service.removerItem("tamanhos", `Inexistente-${Date.now()}`, USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("rejeita lista inválida tanto para adicionar quanto para remover", async () => {
      await expect(service.adicionarItem("promocoes", "valor", USUARIO_ID)).rejects.toThrow(ApiException);
      await expect(service.removerItem("promocoes", "valor", USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("listas ficam vazias novamente após remover o único item — contrato permite listas vazias", async () => {
      const chave = `Sozinho-${Date.now()}`;
      await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
      const apos = await service.removerItem("formasPagamento", chave, USUARIO_ID);
      expect(apos.formasPagamento).not.toContain(chave);
    });
  });

  describe("auditoria (eventos_configuracao)", () => {
    const eventosDoAtor = () =>
      connection.collection("eventos_configuracao").find({ usuarioId: USUARIO_AUDITORIA_ID }).sort({ criadoEm: 1 }).toArray();

    beforeEach(async () => {
      await connection.collection("eventos_configuracao").deleteMany({ usuarioId: USUARIO_AUDITORIA_ID });
    });

    it("atualizarLoja registra configuracao.loja_atualizada com o ator e só os NOMES dos campos alterados", async () => {
      await service.atualizarLoja(lojaValida({ nome: "Base", telefone: "1", email: "a@b.com" }), USUARIO_ID);
      await connection.collection("eventos_configuracao").deleteMany({ usuarioId: USUARIO_ID, tipo: "configuracao.loja_atualizada" });

      await service.atualizarLoja(
        lojaValida({
          nome: "Nova Razão",
          telefone: "1",
          email: "a@b.com",
          endereco: { cep: "01310-100", logradouro: "Av. Paulista", numero: "1000", complemento: "", bairro: "Bela Vista", cidade: "Campinas", estado: "SP" },
        }),
        USUARIO_AUDITORIA_ID,
      );

      const eventos = await eventosDoAtor();
      expect(eventos).toHaveLength(1);
      expect(eventos[0]!.tipo).toBe("configuracao.loja_atualizada");
      expect(eventos[0]!.usuarioId).toBe(USUARIO_AUDITORIA_ID);
      expect(eventos[0]!.criadoEm).toBeInstanceOf(Date);
      expect([...(eventos[0]!.detalhes.camposAlterados as string[])].sort()).toEqual(["endereco.cidade", "nome"]);
    });

    it("o evento da loja não carrega valores nem o documento inteiro (nem e-mail, telefone, logo)", async () => {
      await service.atualizarLoja(lojaValida({ email: "segredo-pessoal@loja.com", telefone: "11955554444", nome: "Nome Sensível" }), USUARIO_AUDITORIA_ID);

      const [evento] = await eventosDoAtor();
      expect(Object.keys(evento!.detalhes)).toEqual(["camposAlterados"]);
      const serializado = JSON.stringify(evento);
      for (const valor of ["segredo-pessoal@loja.com", "11955554444", "Nome Sensível", "https://exemplo.com/logo.png", "Bela Vista"]) {
        expect(serializado).not.toContain(valor);
      }
    });

    it("atualizarLoja sem nenhuma diferença ainda registra o evento, com camposAlterados vazio", async () => {
      await service.atualizarLoja(lojaValida(), USUARIO_ID);
      await connection.collection("eventos_configuracao").deleteMany({ usuarioId: USUARIO_AUDITORIA_ID });
      await service.atualizarLoja(lojaValida(), USUARIO_AUDITORIA_ID);

      const eventos = await eventosDoAtor();
      expect(eventos).toHaveLength(1);
      expect(eventos[0]!.detalhes.camposAlterados).toEqual([]);
    });

    it("adicionarItem registra configuracao.item_adicionado com lista, valor (já com trim) e ator", async () => {
      const chave = `Auditada-${Date.now()}`;
      await service.adicionarItem("categorias", `  ${chave}  `, USUARIO_AUDITORIA_ID);

      const eventos = await eventosDoAtor();
      expect(eventos).toHaveLength(1);
      expect(eventos[0]!.tipo).toBe("configuracao.item_adicionado");
      expect(eventos[0]!.usuarioId).toBe(USUARIO_AUDITORIA_ID);
      expect(eventos[0]!.detalhes).toEqual({ lista: "categorias", valor: chave });
    });

    it("removerItem registra configuracao.item_removido com lista, valor e ator", async () => {
      const chave = `AuditadaRemocao-${Date.now()}`;
      await service.adicionarItem("cores", chave, USUARIO_ID);
      await service.removerItem("cores", chave, USUARIO_AUDITORIA_ID);

      const eventos = await eventosDoAtor();
      expect(eventos).toHaveLength(1);
      expect(eventos[0]!.tipo).toBe("configuracao.item_removido");
      expect(eventos[0]!.usuarioId).toBe(USUARIO_AUDITORIA_ID);
      expect(eventos[0]!.detalhes).toEqual({ lista: "cores", valor: chave });
    });

    it("operações que falham (lista inválida, valor vazio, duplicado, inexistente) não geram evento", async () => {
      const chave = `SemEvento-${Date.now()}`;
      await service.adicionarItem("tamanhos", chave, USUARIO_ID);

      await expect(service.adicionarItem("promocoes", "x", USUARIO_AUDITORIA_ID)).rejects.toThrow(ApiException);
      await expect(service.adicionarItem("tamanhos", "   ", USUARIO_AUDITORIA_ID)).rejects.toThrow(ApiException);
      await expect(service.adicionarItem("tamanhos", chave, USUARIO_AUDITORIA_ID)).rejects.toThrow(ApiException);
      await expect(service.removerItem("tamanhos", `Inexistente-${Date.now()}`, USUARIO_AUDITORIA_ID)).rejects.toThrow(ApiException);
      await expect(service.removerItem("promocoes", "x", USUARIO_AUDITORIA_ID)).rejects.toThrow(ApiException);

      expect(await eventosDoAtor()).toHaveLength(0);
    });
  });

  describe("concorrência", () => {
    it("N adições concorrentes de valores DIFERENTES: todas persistem, nenhuma perdida (nunca lost update)", async () => {
      const chave = Date.now();
      const valores = Array.from({ length: 10 }, (_, indice) => `Concorrente-${chave}-${indice}`);

      const resultados = await Promise.allSettled(valores.map((valor) => service.adicionarItem("categorias", valor, USUARIO_ID)));
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);

      const final = await service.obter();
      for (const valor of valores) {
        expect(final.categorias).toContain(valor);
      }
    });

    it("N adições concorrentes do MESMO valor: só uma persiste, as demais rejeitam por conflito", async () => {
      const chave = `Corrida-${Date.now()}`;
      const resultados = await Promise.allSettled(Array.from({ length: 5 }, () => service.adicionarItem("cores", chave, USUARIO_ID)));

      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(4);

      const final = await service.obter();
      expect(final.cores.filter((item) => item === chave)).toHaveLength(1);
    });
  });

  describe("unicidade case-insensitive (Fase 54.0)", () => {
    it("cadastra 'Preto' normalmente", async () => {
      const chave = `Preto-${Date.now()}`;
      const resultado = await service.adicionarItem("cores", chave, USUARIO_ID);
      expect(resultado.cores).toContain(chave);
    });

    it("rejeita cadastrar a mesma cor em minúsculas ('preto')", async () => {
      const chave = `Preto2-${Date.now()}`;
      await service.adicionarItem("cores", chave, USUARIO_ID);
      await expect(service.adicionarItem("cores", chave.toLowerCase(), USUARIO_ID)).rejects.toThrow(ApiException);

      const final = await service.obter();
      // A forma ORIGINALMENTE cadastrada é preservada — nenhuma reescrita de apresentação.
      expect(final.cores).toContain(chave);
      expect(final.cores).not.toContain(chave.toLowerCase());
    });

    it("rejeita cadastrar a mesma cor em MAIÚSCULAS ('PRETO')", async () => {
      const chave = `Preto3-${Date.now()}`;
      await service.adicionarItem("cores", chave, USUARIO_ID);
      await expect(service.adicionarItem("cores", chave.toUpperCase(), USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("cadastra 'P' (tamanho) normalmente", async () => {
      const chave = `P-${Date.now()}`;
      const resultado = await service.adicionarItem("tamanhos", chave, USUARIO_ID);
      expect(resultado.tamanhos).toContain(chave);
    });

    it("rejeita cadastrar o mesmo tamanho em minúsculas ('p')", async () => {
      const chave = `P2-${Date.now()}`;
      await service.adicionarItem("tamanhos", chave, USUARIO_ID);
      await expect(service.adicionarItem("tamanhos", chave.toLowerCase(), USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("rejeita cadastrar o mesmo tamanho com espaços excedentes ('  P2-... ')", async () => {
      const chave = `P3-${Date.now()}`;
      await service.adicionarItem("tamanhos", chave, USUARIO_ID);
      await expect(service.adicionarItem("tamanhos", `   ${chave}   `, USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it(
      "não existe operação de 'editar' cor/tamanho no backend hoje (só adicionar/remover) — " +
        "não há como testar 'edição para nome já existente' sem inventar um endpoint fora do escopo desta fase",
      () => {
        expect(typeof (service as unknown as { editarItem?: unknown }).editarItem).toBe("undefined");
      },
    );

    it("exclusão de cor sem vínculo funciona normalmente", async () => {
      const chave = `SemVinculoCor-${Date.now()}`;
      await service.adicionarItem("cores", chave, USUARIO_ID);
      const resultado = await service.removerItem("cores", chave, USUARIO_ID);
      expect(resultado.cores).not.toContain(chave);
    });

    it("exclusão de tamanho sem vínculo funciona normalmente", async () => {
      const chave = `SemVinculoTam-${Date.now()}`;
      await service.adicionarItem("tamanhos", chave, USUARIO_ID);
      const resultado = await service.removerItem("tamanhos", chave, USUARIO_ID);
      expect(resultado.tamanhos).not.toContain(chave);
    });
  });

  describe("proteção contra exclusão com vínculo (Fase 54.0)", () => {
    // O describe "singleton" (acima) apaga o documento inteiro de `configuracoes`
    // para testar a recriação do upsert — isso destrói o registro de "Vestidos"
    // feito uma única vez no `beforeAll` global. Cada teste abaixo já re-registra
    // sua própria cor/tamanho fresca no corpo; "categorias" precisa do mesmo
    // tratamento aqui (Fase 55.1), já que `produtosService.criar` agora valida.
    beforeEach(async () => {
      await garantirItemConfiguracao(service, "categorias", "Vestidos");
    });

    it("bloqueia a exclusão de cor usada por uma variante, com a mensagem de negócio exata, e preserva os dados", async () => {
      const chave = `Vermelho-${Date.now()}`;
      await service.adicionarItem("cores", chave, USUARIO_ID);
      const produto = await produtosService.criar(payloadProduto("P1"), null);
      await produtosService.adicionarVariante(produto.id, { cor: chave }, null);

      await expect(service.removerItem("cores", chave, USUARIO_ID)).rejects.toThrow(
        "Não foi possível excluir esta cor porque existem produtos vinculados a ela no sistema. Remova ou altere os vínculos antes de tentar novamente.",
      );

      const final = await service.obter();
      expect(final.cores).toContain(chave); // nada foi modificado
    });

    it("bloqueia a exclusão de cor mesmo quando o caso usado na variante difere (case-insensitive)", async () => {
      const chave = `Verde-${Date.now()}`;
      await service.adicionarItem("cores", chave, USUARIO_ID);
      const produto = await produtosService.criar(payloadProduto("P2"), null);
      // Variante cadastrada com uma grafia diferente (minúsculas) da mesma cor.
      await produtosService.adicionarVariante(produto.id, { cor: chave.toLowerCase() }, null);

      await expect(service.removerItem("cores", chave, USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("bloqueia a exclusão de tamanho usado por uma variante, com a mensagem de negócio exata, e preserva os dados", async () => {
      const chave = `GG-${Date.now()}`;
      const corAuxiliar = `Qualquer-${Date.now()}`;
      await service.adicionarItem("tamanhos", chave, USUARIO_ID);
      // Fase 54.2 — `adicionarVariante` agora exige que a cor exista em `configuracoes.cores`.
      await service.adicionarItem("cores", corAuxiliar, USUARIO_ID);
      const produto = await produtosService.criar(payloadProduto("P3"), null);
      const variante = await produtosService.adicionarVariante(produto.id, { cor: corAuxiliar }, null);
      await produtosService.adicionarTamanho(produto.id, String(variante._id), { tamanho: chave, quantidade: 1 }, null);

      await expect(service.removerItem("tamanhos", chave, USUARIO_ID)).rejects.toThrow(
        "Não foi possível excluir este tamanho porque existem produtos vinculados a ele no sistema. Remova ou altere os vínculos antes de tentar novamente.",
      );

      const final = await service.obter();
      expect(final.tamanhos).toContain(chave);
    });

    it("uma tentativa de exclusão bloqueada não altera o produto/variante vinculados", async () => {
      const chave = `Rosa-${Date.now()}`;
      await service.adicionarItem("cores", chave, USUARIO_ID);
      const produto = await produtosService.criar(payloadProduto("P4"), null);
      const variante = await produtosService.adicionarVariante(produto.id, { cor: chave }, null);

      await expect(service.removerItem("cores", chave, USUARIO_ID)).rejects.toThrow(ApiException);

      const produtoBruto = await connection.collection("produtos").findOne({ codProduto: produto.codProduto });
      expect(produtoBruto?.["excluidoEm"]).toBeNull();
      expect(produtoBruto?.["variantes"]).toHaveLength(1);
      expect((produtoBruto?.["variantes"] as Array<{ _id: unknown }>)[0]?._id?.toString()).toBe(String(variante._id));
    });

    it("depois que o produto/variante é removido, a exclusão da cor passa a funcionar", async () => {
      const chave = `Laranja-${Date.now()}`;
      await service.adicionarItem("cores", chave, USUARIO_ID);
      const produto = await produtosService.criar(payloadProduto("P5"), null);
      const variante = await produtosService.adicionarVariante(produto.id, { cor: chave }, null);

      await expect(service.removerItem("cores", chave, USUARIO_ID)).rejects.toThrow(ApiException);

      await produtosService.removerVariante(produto.id, String(variante._id), null);
      const resultado = await service.removerItem("cores", chave, USUARIO_ID);
      expect(resultado.cores).not.toContain(chave);
    });

    it(
      "concorrência real: excluir a cor e criar uma variante que a usa ao mesmo tempo nunca deixa a " +
        "configuração inconsistente com os produtos — ou a cor continua presente E a variante existe, " +
        "ou a cor foi removida E nenhuma variante a usa",
      async () => {
        const chave = `Roxo-${Date.now()}`;
        await service.adicionarItem("cores", chave, USUARIO_ID);
        const produto = await produtosService.criar(payloadProduto("P6"), null);

        // Duas operações concorrentes de verdade (mesmo padrão já usado pelos
        // testes de concorrência acima neste arquivo): o próprio event
        // loop/I-O real do MongoDB de teste decide o entrelaçamento, não o
        // teste. Não há transação multi-documento disponível neste projeto
        // (ver `removerItem`) — por isso a garantia vem de checar→agir→
        // reconferir→compensar, testado aqui pelo resultado observável, não
        // por instrumentar o entrelaçamento exato.
        const [resultadoRemocao] = await Promise.allSettled([
          service.removerItem("cores", chave, USUARIO_ID),
          produtosService.adicionarVariante(produto.id, { cor: chave }, null),
        ]);

        const final = await service.obter();
        const produtoFinal = await produtosService.obterPorId(produto.id);
        const varianteExiste = produtoFinal.variantes.some((v) => v.cor === chave);
        const corPresente = final.cores.includes(chave);

        if (resultadoRemocao.status === "fulfilled") {
          // Remoção venceu a corrida antes da variante existir: nada ficou vinculado.
          expect(corPresente).toBe(false);
          expect(varianteExiste).toBe(false);
        } else {
          // A variante existiu a tempo de ser vista (na checagem prévia OU na
          // reconferência pós-remoção, com compensação): a cor nunca fica
          // ausente enquanto uma variante a usa.
          expect(corPresente).toBe(true);
        }
        // Invariante final, válido nos dois casos: nunca existe uma variante
        // usando uma cor que não está mais cadastrada.
        if (varianteExiste) expect(corPresente).toBe(true);
      },
    );
  });

  describe("categoria: unicidade, proteção de exclusão e campo-espelho (Fase 55.1)", () => {
    it("cadastra uma categoria normalmente", async () => {
      const chave = `Calcas-${Date.now()}`;
      const resultado = await service.adicionarItem("categorias", chave, USUARIO_ID);
      expect(resultado.categorias).toContain(chave);
    });

    it("rejeita cadastrar a mesma categoria em minúsculas", async () => {
      const chave = `Saias-${Date.now()}`;
      await service.adicionarItem("categorias", chave, USUARIO_ID);
      await expect(service.adicionarItem("categorias", chave.toLowerCase(), USUARIO_ID)).rejects.toThrow(ApiException);

      const final = await service.obter();
      // A forma ORIGINALMENTE cadastrada é preservada — nenhuma reescrita de apresentação.
      expect(final.categorias).toContain(chave);
      expect(final.categorias).not.toContain(chave.toLowerCase());
    });

    it("rejeita cadastrar a mesma categoria em MAIÚSCULAS", async () => {
      const chave = `Blusas-${Date.now()}`;
      await service.adicionarItem("categorias", chave, USUARIO_ID);
      await expect(service.adicionarItem("categorias", chave.toUpperCase(), USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("rejeita cadastrar a mesma categoria com acentuação diferente ('Calçados' vs 'Calcados')", async () => {
      const chave = `Calçados-${Date.now()}`;
      await service.adicionarItem("categorias", chave, USUARIO_ID);
      const semAcento = chave.replace("ç", "c");
      await expect(service.adicionarItem("categorias", semAcento, USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("rejeita cadastrar a mesma categoria com espaços periféricos excedentes", async () => {
      const chave = `Macacoes-${Date.now()}`;
      await service.adicionarItem("categorias", chave, USUARIO_ID);
      await expect(service.adicionarItem("categorias", `   ${chave}   `, USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("exclusão de categoria sem vínculo funciona normalmente", async () => {
      const chave = `SemVinculoCategoria-${Date.now()}`;
      await service.adicionarItem("categorias", chave, USUARIO_ID);
      const resultado = await service.removerItem("categorias", chave, USUARIO_ID);
      expect(resultado.categorias).not.toContain(chave);
    });

    describe("bloqueio com produto vinculado", () => {
      // Mesmo motivo do describe "proteção contra exclusão com vínculo" acima:
      // o describe "singleton" apaga o documento inteiro de `configuracoes`.
      beforeEach(async () => {
        await garantirItemConfiguracao(service, "categorias", "Vestidos");
      });

      it("bloqueia a exclusão de categoria usada por um produto ativo, com a mensagem de negócio exata, e preserva os dados", async () => {
        const chave = `Macacao-${Date.now()}`;
        await service.adicionarItem("categorias", chave, USUARIO_ID);
        const produto = await produtosService.criar(payloadProduto("CAT1", { categoria: chave }), null);

        await expect(service.removerItem("categorias", chave, USUARIO_ID)).rejects.toThrow(
          "Não foi possível excluir esta categoria porque existem produtos vinculados a ela no sistema. Remova ou altere os vínculos antes de tentar novamente.",
        );

        const final = await service.obter();
        expect(final.categorias).toContain(chave); // nada foi modificado

        const produtoBruto = await connection.collection("produtos").findOne({ codProduto: produto.codProduto });
        expect(produtoBruto?.["categoria"]).toBe(chave);
        expect(produtoBruto?.["excluidoEm"]).toBeNull();
      });

      it("bloqueia a exclusão de categoria mesmo quando o produto usa uma grafia diferente (case/acento-insensitive)", async () => {
        const chave = `Vestido-${Date.now()}`;
        await service.adicionarItem("categorias", chave, USUARIO_ID);
        await produtosService.criar(payloadProduto("CAT2", { categoria: chave.toUpperCase() }), null);

        await expect(service.removerItem("categorias", chave, USUARIO_ID)).rejects.toThrow(ApiException);
      });

      it("depois que o produto é excluído (soft-delete), a exclusão da categoria passa a funcionar", async () => {
        const chave = `Camisa-${Date.now()}`;
        await service.adicionarItem("categorias", chave, USUARIO_ID);
        const produto = await produtosService.criar(payloadProduto("CAT3", { categoria: chave }), null);

        await expect(service.removerItem("categorias", chave, USUARIO_ID)).rejects.toThrow(ApiException);

        await produtosService.excluir(produto.id, null);
        const resultado = await service.removerItem("categorias", chave, USUARIO_ID);
        expect(resultado.categorias).not.toContain(chave);
      });

      it(
        "concorrência real: excluir a categoria e criar um produto que a usa ao mesmo tempo nunca deixa a " +
          "configuração inconsistente com os produtos — ou a categoria continua presente E o produto existe, " +
          "ou a categoria foi removida E nenhum produto ativo a usa",
        async () => {
          const chave = `Shorts-${Date.now()}`;
          await service.adicionarItem("categorias", chave, USUARIO_ID);

          const [resultadoRemocao, resultadoCriacao] = await Promise.allSettled([
            service.removerItem("categorias", chave, USUARIO_ID),
            produtosService.criar(payloadProduto("CAT4", { categoria: chave }), null),
          ]);

          const final = await service.obter();
          const categoriaPresente = final.categorias.includes(chave);
          const produtoExiste =
            resultadoCriacao.status === "fulfilled" &&
            (await produtosService.obterPorId(resultadoCriacao.value.id)).excluidoEm === null;

          if (resultadoRemocao.status === "fulfilled") {
            expect(categoriaPresente).toBe(false);
          }
          // Invariante final, válido em todos os casos: nunca existe um produto
          // ativo usando uma categoria que não está mais cadastrada.
          if (produtoExiste) expect(categoriaPresente).toBe(true);
        },
      );
    });

    it("o campo-espelho 'categoriasNormalizadas' nunca é exposto na serialização pública", async () => {
      const chave = `EspelhoInterno-${Date.now()}`;
      await service.adicionarItem("categorias", chave, USUARIO_ID);
      const documento = await service.obter();
      const serializado = documento.toJSON() as Record<string, unknown>;
      expect(Object.keys(serializado).sort()).toEqual(["atualizadoEm", "categorias", "cores", "formasPagamento", "loja", "tamanhos"].sort());
      expect(serializado["categoriasNormalizadas"]).toBeUndefined();
    });

    it("autocorrige (idempotente, aditivo) um documento antigo sem o campo-espelho 'categoriasNormalizadas'", async () => {
      const chave = `LegadoSemEspelho-${Date.now()}`;
      // Simula um documento criado ANTES da Fase 55.1: a categoria já existe em
      // `categorias`, mas o espelho normalizado nunca foi populado para ela —
      // só possível manipulando o Mongo diretamente (a API nunca permite esse
      // estado hoje), igual ao padrão já usado para cores/tamanhos.
      await connection.collection("configuracoes").updateOne({ _id: "global" }, { $addToSet: { categorias: chave } });
      const antes = await connection.collection("configuracoes").findOne({ _id: "global" });
      expect((antes?.["categoriasNormalizadas"] as string[] | undefined) ?? []).not.toContain(chave.toLowerCase());

      // Qualquer adição subsequente dispara o self-heal (`sincronizarEspelhoNormalizado`).
      await service.adicionarItem("categorias", `Gatilho-${Date.now()}`, USUARIO_ID);

      const depois = await connection.collection("configuracoes").findOne({ _id: "global" });
      expect(depois?.["categoriasNormalizadas"] as string[]).toContain(chave.toLowerCase());

      // E a unicidade case-insensitive passa a valer também para o valor legado.
      await expect(service.adicionarItem("categorias", chave.toUpperCase(), USUARIO_ID)).rejects.toThrow(ApiException);
    });
  });

  describe("forma de pagamento: unicidade, proteção de exclusão e campo-espelho (Fase 55.2)", () => {
    it("cadastra uma forma de pagamento normalmente", async () => {
      const chave = `Vale-${Date.now()}`;
      const resultado = await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
      expect(resultado.formasPagamento).toContain(chave);
    });

    it("rejeita cadastrar a mesma forma em minúsculas", async () => {
      const chave = `Transferencia-${Date.now()}`;
      await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
      await expect(service.adicionarItem("formasPagamento", chave.toLowerCase(), USUARIO_ID)).rejects.toThrow(ApiException);

      const final = await service.obter();
      expect(final.formasPagamento).toContain(chave);
      expect(final.formasPagamento).not.toContain(chave.toLowerCase());
    });

    it("rejeita cadastrar a mesma forma em MAIÚSCULAS", async () => {
      const chave = `Cheque-${Date.now()}`;
      await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
      await expect(service.adicionarItem("formasPagamento", chave.toUpperCase(), USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("rejeita cadastrar a mesma forma com acentuação diferente ('Débito Á vista' vs 'Debito A vista')", async () => {
      const chave = `DebitoAVista-${Date.now()}-Á`;
      await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
      const semAcento = chave.replace("Á", "A");
      await expect(service.adicionarItem("formasPagamento", semAcento, USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("rejeita cadastrar a mesma forma com espaços periféricos excedentes", async () => {
      const chave = `Fiado-${Date.now()}`;
      await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
      await expect(service.adicionarItem("formasPagamento", `   ${chave}   `, USUARIO_ID)).rejects.toThrow(ApiException);
    });

    it("exclusão de forma de pagamento sem vínculo funciona normalmente", async () => {
      const chave = `SemVinculoForma-${Date.now()}`;
      await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
      const resultado = await service.removerItem("formasPagamento", chave, USUARIO_ID);
      expect(resultado.formasPagamento).not.toContain(chave);
    });

    it("o campo-espelho 'formasPagamentoNormalizadas' nunca é exposto na serialização pública", async () => {
      const chave = `EspelhoFormaInterno-${Date.now()}`;
      await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
      const documento = await service.obter();
      const serializado = documento.toJSON() as Record<string, unknown>;
      expect(Object.keys(serializado).sort()).toEqual(["atualizadoEm", "categorias", "cores", "formasPagamento", "loja", "tamanhos"].sort());
      expect(serializado["formasPagamentoNormalizadas"]).toBeUndefined();
    });

    it("autocorrige (idempotente, aditivo) um documento antigo sem o campo-espelho 'formasPagamentoNormalizadas'", async () => {
      const chave = `LegadoFormaSemEspelho-${Date.now()}`;
      await connection.collection("configuracoes").updateOne({ _id: "global" }, { $addToSet: { formasPagamento: chave } });
      const antes = await connection.collection("configuracoes").findOne({ _id: "global" });
      expect((antes?.["formasPagamentoNormalizadas"] as string[] | undefined) ?? []).not.toContain(chave.toLowerCase());

      await service.adicionarItem("formasPagamento", `GatilhoForma-${Date.now()}`, USUARIO_ID);

      const depois = await connection.collection("configuracoes").findOne({ _id: "global" });
      expect(depois?.["formasPagamentoNormalizadas"] as string[]).toContain(chave.toLowerCase());
      await expect(service.adicionarItem("formasPagamento", chave.toUpperCase(), USUARIO_ID)).rejects.toThrow(ApiException);
    });

    describe("bloqueio com vínculo histórico (vendas e movimentos de caixa)", () => {
      // Mesmo motivo do describe "proteção contra exclusão com vínculo" (cor)
      // e do describe de categoria acima: o describe "singleton" apaga o
      // documento inteiro de `configuracoes` mid-suite.
      beforeEach(async () => {
        await garantirItemConfiguracao(service, "formasPagamento", "Pix-Base");
      });

      it("bloqueia a exclusão de forma vinculada a 'vendas.formaPagamento' (campo raiz), com a mensagem de negócio exata, e preserva os dados", async () => {
        const chave = `VendaRaiz-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        const venda = await vendaModel.create(dadosVendaMinima({ formaPagamento: chave }));

        await expect(service.removerItem("formasPagamento", chave, USUARIO_ID)).rejects.toThrow(
          "Não foi possível excluir esta forma de pagamento porque existem vendas ou movimentações financeiras vinculadas a ela. Verifique os vínculos antes de tentar novamente.",
        );

        const final = await service.obter();
        expect(final.formasPagamento).toContain(chave); // nada foi modificado
        const vendaBruta = await connection.collection("vendas").findOne({ _id: venda._id });
        expect(vendaBruta?.["formaPagamento"]).toBe(chave);
      });

      it("bloqueia a exclusão de forma vinculada a 'vendas.pagamentos[].forma'", async () => {
        const chave = `PagamentoArray-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        await vendaModel.create(
          dadosVendaMinima({
            formaPagamento: "Pix-Base",
            pagamentos: [{ forma: chave, valor: 100, dataPagamento: new Date(), parcelas: 1 } as never],
          }),
        );

        await expect(service.removerItem("formasPagamento", chave, USUARIO_ID)).rejects.toThrow(ApiException);
      });

      it("bloqueia a exclusão de forma vinculada a 'vendas.parcelas[].formaPagamento'", async () => {
        const chave = `ParcelaArray-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        await vendaModel.create(
          dadosVendaMinima({
            formaPagamento: "Pix-Base",
            parcelas: [{ numero: 1, total: 1, valor: 100, vencimento: new Date(), pagoEm: new Date(), formaPagamento: chave } as never],
          }),
        );

        await expect(service.removerItem("formasPagamento", chave, USUARIO_ID)).rejects.toThrow(ApiException);
      });

      it("bloqueia a exclusão de forma vinculada a 'movimentos_caixa.formaPagamento'", async () => {
        const chave = `MovimentoCaixa-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        await movimentoModel.create(dadosMovimentoMinimo({ formaPagamento: chave }));

        await expect(service.removerItem("formasPagamento", chave, USUARIO_ID)).rejects.toThrow(ApiException);
      });

      it("bloqueia a exclusão mesmo quando a venda está CANCELADA — venda cancelada também é histórico", async () => {
        const chave = `VendaCancelada-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        await vendaModel.create(dadosVendaMinima({ formaPagamento: chave, status: "cancelada" }));

        await expect(service.removerItem("formasPagamento", chave, USUARIO_ID)).rejects.toThrow(ApiException);
      });

      it("bloqueia a exclusão mesmo quando o movimento pertence a um caixa já FECHADO — não há exclusão lógica para ignorar histórico", async () => {
        const chave = `CaixaFechado-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        // `MovimentoCaixa` nunca referencia o status do Caixa (é histórico
        // imutável por natureza, independente do caixa estar aberto ou
        // fechado) — `caixaId` aqui aponta para um ObjectId que não
        // corresponde a nenhum documento de `caixas`, de propósito: a
        // checagem de vínculo nunca precisa (nem deve) resolver o Caixa para
        // decidir se bloqueia a exclusão.
        await movimentoModel.create(dadosMovimentoMinimo({ formaPagamento: chave, caixaId: new Types.ObjectId() }));

        await expect(service.removerItem("formasPagamento", chave, USUARIO_ID)).rejects.toThrow(ApiException);
      });

      it("reconhece vínculo mesmo com grafia diferente (caixa/acento/espaços) do valor cadastrado", async () => {
        const chave = `  Crediario-${Date.now()}  `;
        const chaveLimpa = chave.trim();
        await service.adicionarItem("formasPagamento", chaveLimpa, USUARIO_ID);
        await vendaModel.create(dadosVendaMinima({ formaPagamento: chaveLimpa.toUpperCase() }));

        await expect(service.removerItem("formasPagamento", chaveLimpa, USUARIO_ID)).rejects.toThrow(ApiException);
      });

      describe("normalização completa do vínculo histórico — espaços consecutivos (Fase 55.2.1)", () => {
        // A collation do MongoDB (usada numa primeira versão desta fase)
        // resolve caixa/acentuação mas NUNCA colapsa espaços internos
        // consecutivos nem remove espaços periféricos — só a comparação em
        // memória via `normalizarFormaPagamento` (a MESMA função usada no
        // cadastro) reconhece esses quatro testes como vínculo. Cada teste
        // combina as QUATRO variações exigidas (acento + caixa + espaços
        // periféricos + espaços consecutivos) no valor HISTÓRICO
        // armazenado, nunca no valor cadastrado (que permanece limpo) —
        // provando que a proteção funciona mesmo com dado antigo nunca
        // normalizado, sem alterar esse dado histórico em nenhum momento.
        // Suja de propósito: SEM acento, MAIÚSCULAS, espaços periféricos E
        // consecutivos — as quatro variações exigidas, combinadas no MESMO
        // valor histórico, para cada um dos quatro caminhos. Cada teste usa
        // sua PRÓPRIA chave cadastrada (sufixo único) para não colidir com
        // os outros três — todos exercitam a mesma função de normalização.
        function historicaSuja(baseLimpa: string): string {
          return `  ${baseLimpa.replace(/[ãé]/g, (c) => (c === "ã" ? "a" : "e")).toUpperCase().replace(/ /g, "   ")}  `;
        }

        it("bloqueia a exclusão com vínculo em 'vendas.formaPagamento' (campo raiz) armazenado com grafia suja", async () => {
          const cadastrada = `Cartão de Crédito ${Date.now()}`;
          const suja = historicaSuja(cadastrada);
          await service.adicionarItem("formasPagamento", cadastrada, USUARIO_ID);
          const venda = await vendaModel.create(dadosVendaMinima({ formaPagamento: suja }));

          await expect(service.removerItem("formasPagamento", cadastrada, USUARIO_ID)).rejects.toThrow(ApiException);

          // Confirma que o valor histórico NUNCA foi alterado/normalizado.
          const vendaBruta = await connection.collection("vendas").findOne({ _id: venda._id });
          expect(vendaBruta?.["formaPagamento"]).toBe(suja);
        });

        it("bloqueia a exclusão com vínculo em 'vendas.pagamentos[].forma' armazenado com grafia suja", async () => {
          const cadastrada = `Cartão de Crédito Pagto ${Date.now()}`;
          const suja = historicaSuja(cadastrada);
          await service.adicionarItem("formasPagamento", cadastrada, USUARIO_ID);
          await vendaModel.create(
            dadosVendaMinima({
              formaPagamento: "Pix-Base",
              pagamentos: [{ forma: suja, valor: 100, dataPagamento: new Date(), parcelas: 1 } as never],
            }),
          );

          await expect(service.removerItem("formasPagamento", cadastrada, USUARIO_ID)).rejects.toThrow(ApiException);
        });

        it("bloqueia a exclusão com vínculo em 'vendas.parcelas[].formaPagamento' armazenado com grafia suja", async () => {
          const cadastrada = `Cartão de Crédito Parcela ${Date.now()}`;
          const suja = historicaSuja(cadastrada);
          await service.adicionarItem("formasPagamento", cadastrada, USUARIO_ID);
          await vendaModel.create(
            dadosVendaMinima({
              formaPagamento: "Pix-Base",
              parcelas: [{ numero: 1, total: 1, valor: 100, vencimento: new Date(), pagoEm: new Date(), formaPagamento: suja } as never],
            }),
          );

          await expect(service.removerItem("formasPagamento", cadastrada, USUARIO_ID)).rejects.toThrow(ApiException);
        });

        it("bloqueia a exclusão com vínculo em 'movimentos_caixa.formaPagamento' armazenado com grafia suja", async () => {
          const cadastrada = `Cartão de Crédito Caixa ${Date.now()}`;
          const suja = historicaSuja(cadastrada);
          await service.adicionarItem("formasPagamento", cadastrada, USUARIO_ID);
          const movimento = await movimentoModel.create(dadosMovimentoMinimo({ formaPagamento: suja }));

          await expect(service.removerItem("formasPagamento", cadastrada, USUARIO_ID)).rejects.toThrow(ApiException);

          // `MovimentoCaixa.formaPagamento` já tem `trim: true` no schema
          // (pré-existente, não tocado nesta fase) — o Mongoose remove os
          // espaços PERIFÉRICOS na própria gravação; os espaços CONSECUTIVOS
          // internos (o que de fato está sendo testado aqui) permanecem
          // intactos, provando que o histórico não foi alterado por esta
          // fase além do que o schema já fazia antes dela.
          const movimentoBruto = await connection.collection("movimentos_caixa").findOne({ _id: movimento._id });
          expect(movimentoBruto?.["formaPagamento"]).toBe(suja.trim());
        });

        it("exclusão funciona normalmente quando NENHUM registro (limpo ou sujo) usa a forma", async () => {
          const semVinculo = `SemVinculoNormalizacao-${Date.now()}`;
          await service.adicionarItem("formasPagamento", semVinculo, USUARIO_ID);
          const resultado = await service.removerItem("formasPagamento", semVinculo, USUARIO_ID);
          expect(resultado.formasPagamento).not.toContain(semVinculo);
        });
      });

      it("uma tentativa de exclusão bloqueada não altera a venda vinculada", async () => {
        const chave = `PreservaVenda-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        const venda = await vendaModel.create(dadosVendaMinima({ formaPagamento: chave }));

        await expect(service.removerItem("formasPagamento", chave, USUARIO_ID)).rejects.toThrow(ApiException);

        const vendaFinal = await connection.collection("vendas").findOne({ _id: venda._id });
        expect(vendaFinal?.["formaPagamento"]).toBe(chave);
        expect(vendaFinal?.["status"]).toBe(venda.status);
      });

      it("depois que a venda vinculada é removida (compensação de teste), a exclusão da forma passa a funcionar", async () => {
        const chave = `LiberaDepois-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        const venda = await vendaModel.create(dadosVendaMinima({ formaPagamento: chave }));

        await expect(service.removerItem("formasPagamento", chave, USUARIO_ID)).rejects.toThrow(ApiException);

        // Não existe exclusão lógica de venda no domínio real (decisão da
        // Fase 55.2) — este `deleteOne` é só para provar, isoladamente, que
        // `existeVinculo` reflete corretamente a AUSÊNCIA de vínculo quando
        // ele de fato não existe mais, nunca para simular um fluxo de
        // produção real.
        await vendaModel.deleteOne({ _id: venda._id });
        const resultado = await service.removerItem("formasPagamento", chave, USUARIO_ID);
        expect(resultado.formasPagamento).not.toContain(chave);
      });

      it(
        "concorrência real: excluir a forma e criar uma venda que a usa ao mesmo tempo nunca deixa a " +
          "configuração inconsistente — ou a forma continua presente E a venda existe, ou a forma foi " +
          "removida E nenhuma venda a usa",
        async () => {
          const chave = `ConcorrenciaForma-${Date.now()}`;
          await service.adicionarItem("formasPagamento", chave, USUARIO_ID);

          const [resultadoRemocao, resultadoCriacao] = await Promise.allSettled([
            service.removerItem("formasPagamento", chave, USUARIO_ID),
            vendaModel.create(dadosVendaMinima({ formaPagamento: chave })),
          ]);

          const final = await service.obter();
          const formaPresente = final.formasPagamento.includes(chave);

          if (resultadoRemocao.status === "fulfilled") {
            expect(formaPresente).toBe(false);
          }
          if (resultadoCriacao.status === "fulfilled") {
            // A venda foi persistida a tempo de ser vista (na checagem prévia
            // OU na reconferência pós-remoção, com compensação): a forma
            // nunca fica ausente enquanto uma venda ainda a referencia.
            expect(formaPresente).toBe(true);
          }
        },
      );
    });
  });
});
