import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { mongo, Types, type Connection, type Model } from "mongoose";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { liberarTudo, novoPonto, type PontoDeParada } from "../../test-utils/barreira.util.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { MovimentoCaixa, type MovimentoCaixaDocument } from "../caixas/schemas/movimento-caixa.schema.js";
import type { CriarProdutoDto } from "../produtos/dto/criar-produto.dto.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { normalizarCor, normalizarTamanho } from "../produtos/utils/normalizacao.util.js";
import { SequenciasService } from "../sequencias/sequencias.service.js";
import { Venda, type PagamentoVenda, type ParcelaVenda, type VendaDocument } from "../vendas/schemas/venda.schema.js";
import { VendasService } from "../vendas/vendas.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { ConfiguracoesModule } from "./configuracoes.module.js";
import { ConfiguracoesRepository } from "./configuracoes.repository.js";
import { ConfiguracoesService } from "./configuracoes.service.js";
import type { AtualizarLojaDto } from "./dto/atualizar-loja.dto.js";
import type { Configuracao } from "./schemas/configuracao.schema.js";

let contadorVenda = 0;
/** Documento MÍNIMO válido de Venda, inserido via o próprio Model do Mongoose (defaults do schema aplicados) — usado SÓ para testar os vínculos de forma de pagamento, nunca para exercitar regra de negócio de Vendas (isso é feito em `vendas.service.spec.ts`). */
/**
 * Fase 55.9 — formato de ENTRADA da fixture (o que `Model.create` grava), não o
 * tipo hidratado: em `Venda`, `pagamentos`/`parcelas` são `DocumentArray`, mas
 * a fixture passa objetos simples (antes forçados com `as never`).
 */
type DadosVendaFixture = Omit<Partial<Venda>, "pagamentos" | "parcelas"> & {
  pagamentos?: Partial<PagamentoVenda>[];
  parcelas?: Partial<ParcelaVenda>[];
};

function dadosVendaMinima(extra: DadosVendaFixture = {}): DadosVendaFixture {
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
  };
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
    await connection.collection<Configuracao>("configuracoes").deleteMany({});
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
      await connection.collection<Configuracao>("configuracoes").deleteMany({});
      const configuracao = await service.obter();
      expect(configuracao.categorias).toEqual([]);
      expect(configuracao.tamanhos).toEqual([]);
      expect(configuracao.cores).toEqual([]);
      expect(configuracao.formasPagamento).toEqual([]);
      expect(configuracao.loja.nome).toBe("");

      const total = await connection.collection<Configuracao>("configuracoes").countDocuments({});
      expect(total).toBe(1); // nunca mais de um documento
    });

    it("chamadas repetidas de obter() sempre devolvem o MESMO documento (nunca cria um segundo)", async () => {
      const primeira = await service.obter();
      const segunda = await service.obter();
      expect(String(primeira._id)).toBe(String(segunda._id));

      const total = await connection.collection<Configuracao>("configuracoes").countDocuments({});
      expect(total).toBe(1);
    });

    it("dez chamadas concorrentes a obter() nunca criam mais de um documento", async () => {
      await connection.collection<Configuracao>("configuracoes").deleteMany({});
      await Promise.all(Array.from({ length: 10 }, () => service.obter()));
      const total = await connection.collection<Configuracao>("configuracoes").countDocuments({});
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

      const total = await connection.collection<Configuracao>("configuracoes").countDocuments({});
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

    // Fase 56.2 — garantia independente da ordem: o `$push` condicional no
    // campo-espelho é atômico, então QUALQUER entrelaçamento produz o mesmo
    // resultado (não precisa de barreira).
    it("garantia: N adições concorrentes de grafias EQUIVALENTES após normalização — só uma persiste e o espelho tem uma única entrada", async () => {
      const base = `Grafite${Date.now()}`;
      const normalizada = base.toLowerCase();
      const grafias = [base, normalizada, `   ${base.toUpperCase()}   `, base.replace("a", "á"), base.replace("e", "É")];
      const resultados = await Promise.allSettled(grafias.map((grafia) => service.adicionarItem("cores", grafia, USUARIO_ID)));

      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(grafias.length - 1);
      const documento = await connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" });
      expect((documento?.cores ?? []).filter((item) => normalizarCor(item) === normalizada)).toHaveLength(1);
      expect((documento?.coresNormalizadas ?? []).filter((item) => item === normalizada)).toHaveLength(1);
    });
  });

  /**
   * Fase 56.3 — tamanhos. `normalizarTamanho` é SÓ `trim()` + `toUpperCase()`
   * (diferente de cor/categoria/forma): caixa e espaços nas pontas são
   * equivalentes; acentos e espaços internos NÃO são removidos/colapsados.
   * A unicidade vem do `$push` condicional no espelho `tamanhosNormalizados`
   * (atômico), então as asserções concorrentes valem para qualquer ordem.
   */
  describe("tamanhos: normalização e inclusão concorrente (Fase 56.3)", () => {
    async function documentoConfiguracao() {
      return connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" });
    }

    /** Toda entrada de `tamanhos` tem o seu normalizado no espelho, e cada normalizado aparece uma única vez nos dois. */
    function expectEspelhoConsistente(tamanhos: string[], espelho: string[], normalizados: string[]): void {
      for (const normalizado of normalizados) {
        expect(tamanhos.filter((tamanho) => normalizarTamanho(tamanho) === normalizado)).toHaveLength(1);
        expect(espelho.filter((item) => item === normalizado)).toHaveLength(1);
      }
      for (const tamanho of tamanhos) expect(espelho).toContain(normalizarTamanho(tamanho));
    }

    it("normalização real: caixa e espaços nas pontas são equivalentes; acento e espaço interno distinguem tamanhos", async () => {
      const n = Date.now();
      await service.adicionarItem("tamanhos", `p${n}`, USUARIO_ID);
      await expect(service.adicionarItem("tamanhos", `P${n}`, USUARIO_ID)).rejects.toThrow(ApiException);
      await expect(service.adicionarItem("tamanhos", `   p${n}   `, USUARIO_ID)).rejects.toThrow(ApiException);
      // NÃO equivalentes para `normalizarTamanho` (sem remoção de acento nem colapso de espaços):
      await service.adicionarItem("tamanhos", `Ú${n}`, USUARIO_ID);
      await service.adicionarItem("tamanhos", `U${n}`, USUARIO_ID);
      await service.adicionarItem("tamanhos", `G ${n}`, USUARIO_ID);
      await service.adicionarItem("tamanhos", `G  ${n}`, USUARIO_ID);

      const documento = await documentoConfiguracao();
      expectEspelhoConsistente(documento?.tamanhos ?? [], documento?.tamanhosNormalizados ?? [], [`P${n}`, `Ú${n}`, `U${n}`, `G ${n}`, `G  ${n}`]);
      expect(documento?.tamanhos).toContain(`p${n}`); // a grafia original cadastrada é preservada
    });

    it("'u' e ' U ' são a mesma coisa que 'U' (tamanho único) na configuração", async () => {
      await garantirItemConfiguracao(service, "tamanhos", "U");
      await expect(service.adicionarItem("tamanhos", "u", USUARIO_ID)).rejects.toThrow(ApiException);
      await expect(service.adicionarItem("tamanhos", " U ", USUARIO_ID)).rejects.toThrow(ApiException);
      const documento = await documentoConfiguracao();
      expect((documento?.tamanhosNormalizados ?? []).filter((item) => item === "U")).toHaveLength(1);
    });

    it("garantia: N inclusões concorrentes de tamanhos DISTINTOS — todas persistem, sem perda de atualização, espelho consistente", async () => {
      const n = Date.now();
      const tamanhos = Array.from({ length: 8 }, (_, indice) => `D${n}-${indice}`);
      const resultados = await Promise.allSettled(tamanhos.map((tamanho) => service.adicionarItem("tamanhos", tamanho, USUARIO_ID)));
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);
      const documento = await documentoConfiguracao();
      expectEspelhoConsistente(documento?.tamanhos ?? [], documento?.tamanhosNormalizados ?? [], tamanhos);
    });

    it("garantia: N inclusões concorrentes do MESMO tamanho — só uma persiste, as demais rejeitam por duplicidade", async () => {
      const tamanho = `S${Date.now()}`;
      const resultados = await Promise.allSettled(Array.from({ length: 5 }, () => service.adicionarItem("tamanhos", tamanho, USUARIO_ID)));
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(4);
      const documento = await documentoConfiguracao();
      expectEspelhoConsistente(documento?.tamanhos ?? [], documento?.tamanhosNormalizados ?? [], [tamanho]);
    });

    it("garantia: N inclusões concorrentes de grafias EQUIVALENTES (caixa/espaços nas pontas) — só uma persiste e o espelho tem uma única entrada", async () => {
      const n = Date.now();
      const grafias = [`xl${n}`, `XL${n}`, `  Xl${n}  `, `xL${n}`];
      const resultados = await Promise.allSettled(grafias.map((grafia) => service.adicionarItem("tamanhos", grafia, USUARIO_ID)));
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(resultados.filter((r) => r.status === "rejected")).toHaveLength(grafias.length - 1);
      const documento = await documentoConfiguracao();
      expectEspelhoConsistente(documento?.tamanhos ?? [], documento?.tamanhosNormalizados ?? [], [`XL${n}`]);
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

    // Fase 56.2 — a concorrência exclusão × inclusão de variante (antes um
    // `Promise.allSettled` probabilístico afirmando uma garantia inexistente)
    // está no describe "concorrência determinística — exclusão × criação de
    // vínculo (Fase 56.2)", com os entrelaçamentos controlados por barreiras.
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

      // Fase 56.2 — concorrência exclusão × criação de produto: ver o describe
      // "concorrência determinística — exclusão × criação de vínculo (Fase 56.2)".
    });

    it("o campo-espelho 'categoriasNormalizadas' nunca é exposto na serialização pública", async () => {
      const chave = `EspelhoInterno-${Date.now()}`;
      await service.adicionarItem("categorias", chave, USUARIO_ID);
      const documento = await service.obter();
      const serializado: object = documento.toJSON();
      expect(Object.keys(serializado).sort()).toEqual(["atualizadoEm", "categorias", "cores", "formasPagamento", "loja", "tamanhos"].sort());
      expect(Reflect.get(serializado, "categoriasNormalizadas")).toBeUndefined();
    });

    it("autocorrige (idempotente, aditivo) um documento antigo sem o campo-espelho 'categoriasNormalizadas'", async () => {
      const chave = `LegadoSemEspelho-${Date.now()}`;
      // Simula um documento criado ANTES da Fase 55.1: a categoria já existe em
      // `categorias`, mas o espelho normalizado nunca foi populado para ela —
      // só possível manipulando o Mongo diretamente (a API nunca permite esse
      // estado hoje), igual ao padrão já usado para cores/tamanhos.
      await connection.collection<Configuracao>("configuracoes").updateOne({ _id: "global" }, { $addToSet: { categorias: chave } });
      const antes = await connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" });
      expect((antes?.["categoriasNormalizadas"] as string[] | undefined) ?? []).not.toContain(chave.toLowerCase());

      // Qualquer adição subsequente dispara o self-heal (`sincronizarEspelhoNormalizado`).
      await service.adicionarItem("categorias", `Gatilho-${Date.now()}`, USUARIO_ID);

      const depois = await connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" });
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
      const serializado: object = documento.toJSON();
      expect(Object.keys(serializado).sort()).toEqual(["atualizadoEm", "categorias", "cores", "formasPagamento", "loja", "tamanhos"].sort());
      expect(Reflect.get(serializado, "formasPagamentoNormalizadas")).toBeUndefined();
    });

    it("autocorrige (idempotente, aditivo) um documento antigo sem o campo-espelho 'formasPagamentoNormalizadas'", async () => {
      const chave = `LegadoFormaSemEspelho-${Date.now()}`;
      await connection.collection<Configuracao>("configuracoes").updateOne({ _id: "global" }, { $addToSet: { formasPagamento: chave } });
      const antes = await connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" });
      expect((antes?.["formasPagamentoNormalizadas"] as string[] | undefined) ?? []).not.toContain(chave.toLowerCase());

      await service.adicionarItem("formasPagamento", `GatilhoForma-${Date.now()}`, USUARIO_ID);

      const depois = await connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" });
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
            pagamentos: [{ forma: chave, valor: 100, dataPagamento: new Date(), parcelas: 1 }],
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
            parcelas: [{ numero: 1, total: 1, valor: 100, vencimento: new Date(), pagoEm: new Date(), formaPagamento: chave }],
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
              pagamentos: [{ forma: suja, valor: 100, dataPagamento: new Date(), parcelas: 1 }],
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
              parcelas: [{ numero: 1, total: 1, valor: 100, vencimento: new Date(), pagoEm: new Date(), formaPagamento: suja }],
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

      // Fase 56.2 — concorrência exclusão × criação de venda (antes com
      // `vendaModel.create` cru, sem a validação de `VendasService`): ver o
      // describe "concorrência determinística — exclusão × criação de vínculo (Fase 56.2)".
    });
  });

  /**
   * Fase 56.2 — concorrência DETERMINÍSTICA entre excluir um item da
   * configuração e criar um vínculo com ele em outra coleção.
   *
   * O que a implementação faz (`ConfiguracoesService.removerItem`): checa
   * vínculos → `$pull` atômico no documento de configuração → RECHECA →
   * se achou vínculo, COMPENSA (readiciona) e rejeita. Os consumidores
   * (`ProdutosService.criar`/`adicionarVariante`, `VendasService.criar`)
   * validam o item contra a configuração e SÓ DEPOIS gravam em outra
   * coleção, sem reconferir. Sem transação multi-documento (MongoDB
   * standalone), isso é MITIGAÇÃO, não garantia:
   *
   * - GARANTIA (por compensação): se a gravação do vínculo acontece ANTES da
   *   rechecagem, a exclusão é desfeita e rejeitada — configuração e vínculo
   *   ficam consistentes.
   * - LIMITAÇÃO RESIDUAL (documentada, não corrigida): se a gravação acontece
   *   DEPOIS da rechecagem, a exclusão vence e o vínculo é gravado com um item
   *   que não está mais cadastrado.
   *
   * Cada teste fixa o entrelaçamento com barreiras em spies sobre métodos
   * REAIS (que só aguardam e depois chamam o original — nada de banco é
   * simulado): a criação pausa depois da validação e antes da escrita final;
   * a exclusão pausa depois do `$pull` e antes da rechecagem. As barreiras são
   * sempre liberadas e os spies restaurados em `finally`.
   */
  describe("concorrência determinística — exclusão × criação de vínculo (Fase 56.2)", () => {
    /** Exclusão: pausa DEPOIS do `$pull` (checagem inicial já feita) e ANTES da rechecagem. */
    function pausarExclusaoAntesDaRechecagem(ponto: PontoDeParada) {
      const repositorio = moduleRef.get(ConfiguracoesRepository, { strict: false });
      const original = repositorio.removerItemLista.bind(repositorio);
      return spyOn(repositorio, "removerItemLista").mockImplementation(async (campo, valor) => {
        const resultado = await original(campo, valor);
        ponto.chegou.liberar();
        await ponto.liberacao.promessa;
        return resultado;
      });
    }

    /** `ProdutosService.criar`: pausa DEPOIS de `validarCategoriaCadastrada` e ANTES do insert. */
    function pausarInsercaoDeProduto(ponto: PontoDeParada) {
      const repositorio = moduleRef.get(ProdutosRepository, { strict: false });
      const original = repositorio.criar.bind(repositorio);
      return spyOn(repositorio, "criar").mockImplementation(async (dados) => {
        ponto.chegou.liberar();
        await ponto.liberacao.promessa;
        return original(dados);
      });
    }

    /** `ProdutosService.adicionarVariante`: pausa DEPOIS de `validarCorCadastrada` e ANTES do `$push` atômico. */
    function pausarInsercaoDeVariante(ponto: PontoDeParada) {
      const repositorio = moduleRef.get(ProdutosRepository, { strict: false });
      const original = repositorio.adicionarVarianteAtomico.bind(repositorio);
      return spyOn(repositorio, "adicionarVarianteAtomico").mockImplementation(async (produtoId, variante) => {
        ponto.chegou.liberar();
        await ponto.liberacao.promessa;
        return original(produtoId, variante);
      });
    }

    /**
     * `VendasService.criar`: pausa em `proximoValor("venda")` — DEPOIS da
     * validação da forma e da baixa de estoque, ANTES do insert da venda e do
     * movimento de caixa. (`SequenciasService` é singleton; `VendasRepository`
     * é declarado em vários módulos, então um spy nele poderia cair numa
     * instância diferente da usada por `VendasService`.)
     */
    function pausarInsercaoDeVenda(ponto: PontoDeParada) {
      const sequencias = moduleRef.get(SequenciasService, { strict: false });
      const original = sequencias.proximoValor.bind(sequencias);
      return spyOn(sequencias, "proximoValor").mockImplementation(async (chave) => {
        if (chave === "venda") {
          ponto.chegou.liberar();
          await ponto.liberacao.promessa;
        }
        return original(chave);
      });
    }

    /**
     * Fase 56.3 — `ProdutosService.adicionarTamanho`: pausa na entrada de
     * `salvarComRetentativa` — DEPOIS de `validarTamanhoCadastrado`, ANTES da
     * leitura/escrita do produto.
     */
    function pausarGravacaoDeTamanho(ponto: PontoDeParada) {
      const repositorio = moduleRef.get(ProdutosRepository, { strict: false });
      const original = repositorio.salvarComRetentativa.bind(repositorio);
      return spyOn(repositorio, "salvarComRetentativa").mockImplementation(async (id, mutar, tentativas) => {
        ponto.chegou.liberar();
        await ponto.liberacao.promessa;
        return original(id, mutar, tentativas);
      });
    }

    async function produtoAtivo(id: string) {
      return connection.collection("produtos").findOne({ _id: new Types.ObjectId(id), excluidoEm: null });
    }

    describe("cor × inclusão de variante", () => {
      beforeEach(async () => {
        await garantirItemConfiguracao(service, "categorias", "Vestidos");
      });

      it("garantia (compensação): variante gravada ENTRE o $pull e a rechecagem → a cor é readicionada e a exclusão é rejeitada", async () => {
        const chave = `CorComp-${Date.now()}`;
        await service.adicionarItem("cores", chave, USUARIO_ID);
        const produto = await produtosService.criar(payloadProduto("DET-COR-1"), null);
        const pausaVariante = novoPonto();
        const pausaExclusao = novoPonto();
        const espiaoVariante = pausarInsercaoDeVariante(pausaVariante);
        const espiaoExclusao = pausarExclusaoAntesDaRechecagem(pausaExclusao);
        try {
          const inclusao = produtosService.adicionarVariante(produto.id, { cor: chave }, null);
          await pausaVariante.chegou.promessa; // a cor já foi validada como cadastrada
          const exclusao = service.removerItem("cores", chave, USUARIO_ID);
          await pausaExclusao.chegou.promessa; // checagem inicial (sem vínculo) + $pull feitos
          expect((await service.obter()).cores).not.toContain(chave); // janela: removida, ainda sem rechecar

          pausaVariante.liberacao.liberar();
          await inclusao; // variante gravada ANTES da rechecagem
          pausaExclusao.liberacao.liberar();

          await expect(exclusao).rejects.toThrow("Não foi possível excluir esta cor porque existem produtos vinculados a ela no sistema.");
          expect((await service.obter()).cores).toContain(chave); // compensação readicionou
          expect((await produtosService.obterPorId(produto.id)).variantes.some((variante) => variante.cor === chave)).toBe(true);
        } finally {
          liberarTudo(pausaVariante, pausaExclusao);
          espiaoVariante.mockRestore();
          espiaoExclusao.mockRestore();
        }
      });

      it("limitação residual documentada: variante validada ANTES e gravada DEPOIS da rechecagem fica com uma cor não cadastrada", async () => {
        const chave = `CorResidual-${Date.now()}`;
        await service.adicionarItem("cores", chave, USUARIO_ID);
        const produto = await produtosService.criar(payloadProduto("DET-COR-2"), null);
        const pausaVariante = novoPonto();
        const espiaoVariante = pausarInsercaoDeVariante(pausaVariante);
        try {
          const inclusao = produtosService.adicionarVariante(produto.id, { cor: chave }, null);
          await pausaVariante.chegou.promessa; // validada, ainda não gravada
          // A exclusão inteira (checagem → $pull → rechecagem) não vê vínculo nenhum.
          expect((await service.removerItem("cores", chave, USUARIO_ID)).cores).not.toContain(chave);

          pausaVariante.liberacao.liberar();
          await inclusao;

          // Resultado REAL (risco residual aceito, sem transação entre coleções):
          expect((await service.obter()).cores).not.toContain(chave);
          expect((await produtosService.obterPorId(produto.id)).variantes.some((variante) => variante.cor === chave)).toBe(true);
        } finally {
          liberarTudo(pausaVariante);
          espiaoVariante.mockRestore();
        }
      });
    });

    describe("tamanho × inclusão de tamanho na variante (Fase 56.3)", () => {
      beforeEach(async () => {
        await garantirItemConfiguracao(service, "categorias", "Vestidos");
        await garantirItemConfiguracao(service, "cores", "Azul");
      });

      async function produtoComVariante(sufixo: string): Promise<{ produtoId: string; varianteId: string }> {
        const produto = await produtosService.criar(payloadProduto(`DET-TAM-${sufixo}`), null);
        const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
        return { produtoId: produto.id, varianteId: String(variante._id) };
      }

      async function tamanhosDaVariante(produtoId: string, varianteId: string): Promise<string[]> {
        const produto = await produtosService.obterPorId(produtoId);
        return (produto.variantes.find((variante) => String(variante._id) === varianteId)?.tamanhos ?? []).map((item) => item.tamanho);
      }

      it("garantia (compensação): tamanho gravado na variante ENTRE o $pull e a rechecagem → o tamanho é readicionado e a exclusão é rejeitada", async () => {
        const chave = `TC${Date.now()}`;
        await service.adicionarItem("tamanhos", chave, USUARIO_ID);
        const { produtoId, varianteId } = await produtoComVariante("1");
        const pausaTamanho = novoPonto();
        const pausaExclusao = novoPonto();
        const espiaoTamanho = pausarGravacaoDeTamanho(pausaTamanho);
        const espiaoExclusao = pausarExclusaoAntesDaRechecagem(pausaExclusao);
        try {
          const inclusao = produtosService.adicionarTamanho(produtoId, varianteId, { tamanho: chave, quantidade: 2 }, null);
          await pausaTamanho.chegou.promessa; // tamanho já validado como cadastrado
          const exclusao = service.removerItem("tamanhos", chave, USUARIO_ID);
          await pausaExclusao.chegou.promessa;
          expect((await service.obter()).tamanhos).not.toContain(chave);

          pausaTamanho.liberacao.liberar();
          await inclusao; // tamanho gravado na variante ANTES da rechecagem
          pausaExclusao.liberacao.liberar();

          await expect(exclusao).rejects.toThrow("Não foi possível excluir este tamanho porque existem produtos vinculados a ele no sistema.");
          expect((await service.obter()).tamanhos).toContain(chave);
          expect(await tamanhosDaVariante(produtoId, varianteId)).toEqual([chave]);
        } finally {
          liberarTudo(pausaTamanho, pausaExclusao);
          espiaoTamanho.mockRestore();
          espiaoExclusao.mockRestore();
        }
      });

      it("limitação residual documentada: tamanho validado ANTES e gravado na variante DEPOIS da rechecagem fica não cadastrado", async () => {
        const chave = `TR${Date.now()}`;
        await service.adicionarItem("tamanhos", chave, USUARIO_ID);
        const { produtoId, varianteId } = await produtoComVariante("2");
        const pausaTamanho = novoPonto();
        const espiaoTamanho = pausarGravacaoDeTamanho(pausaTamanho);
        try {
          const inclusao = produtosService.adicionarTamanho(produtoId, varianteId, { tamanho: chave, quantidade: 2 }, null);
          await pausaTamanho.chegou.promessa;
          expect((await service.removerItem("tamanhos", chave, USUARIO_ID)).tamanhos).not.toContain(chave);

          pausaTamanho.liberacao.liberar();
          await inclusao;

          // Resultado REAL (mesma janela de cor/categoria/forma, Fase 56.2):
          expect((await service.obter()).tamanhos).not.toContain(chave);
          expect(await tamanhosDaVariante(produtoId, varianteId)).toEqual([chave]);
        } finally {
          liberarTudo(pausaTamanho);
          espiaoTamanho.mockRestore();
        }
      });
    });

    describe("categoria × criação de produto", () => {
      it("garantia (compensação): produto gravado ENTRE o $pull e a rechecagem → a categoria é readicionada e a exclusão é rejeitada", async () => {
        const chave = `CatComp-${Date.now()}`;
        await service.adicionarItem("categorias", chave, USUARIO_ID);
        const pausaProduto = novoPonto();
        const pausaExclusao = novoPonto();
        const espiaoProduto = pausarInsercaoDeProduto(pausaProduto);
        const espiaoExclusao = pausarExclusaoAntesDaRechecagem(pausaExclusao);
        try {
          const criacao = produtosService.criar(payloadProduto("DET-CAT-1", { categoria: chave }), null);
          await pausaProduto.chegou.promessa; // categoria já validada
          const exclusao = service.removerItem("categorias", chave, USUARIO_ID);
          await pausaExclusao.chegou.promessa;
          expect((await service.obter()).categorias).not.toContain(chave);

          pausaProduto.liberacao.liberar();
          const produto = await criacao; // produto gravado ANTES da rechecagem
          pausaExclusao.liberacao.liberar();

          await expect(exclusao).rejects.toThrow("Não foi possível excluir esta categoria porque existem produtos vinculados a ela no sistema.");
          expect((await service.obter()).categorias).toContain(chave);
          expect((await produtoAtivo(produto.id))?.["categoria"]).toBe(chave);
        } finally {
          liberarTudo(pausaProduto, pausaExclusao);
          espiaoProduto.mockRestore();
          espiaoExclusao.mockRestore();
        }
      });

      it("limitação residual documentada: produto validado ANTES e gravado DEPOIS da rechecagem fica ativo com uma categoria não cadastrada", async () => {
        const chave = `CatResidual-${Date.now()}`;
        await service.adicionarItem("categorias", chave, USUARIO_ID);
        const pausaProduto = novoPonto();
        const espiaoProduto = pausarInsercaoDeProduto(pausaProduto);
        try {
          const criacao = produtosService.criar(payloadProduto("DET-CAT-2", { categoria: chave }), null);
          await pausaProduto.chegou.promessa;
          expect((await service.removerItem("categorias", chave, USUARIO_ID)).categorias).not.toContain(chave);

          pausaProduto.liberacao.liberar();
          const produto = await criacao;

          // Resultado REAL — é exatamente a corrida que o teste probabilístico
          // anterior acusava de forma intermitente (13–22% das execuções).
          expect((await service.obter()).categorias).not.toContain(chave);
          expect((await produtoAtivo(produto.id))?.["categoria"]).toBe(chave);
        } finally {
          liberarTudo(pausaProduto);
          espiaoProduto.mockRestore();
        }
      });
    });

    describe("forma de pagamento × criação de venda (VendasService real)", () => {
      type CenarioVenda = { produtoId: string; varianteId: string; tamanhoId: string; vendedorId: string; caixaId: string };

      /** Produto com estoque, vendedor e caixa aberto — tudo pelos serviços reais. */
      async function prepararVenda(sufixo: string): Promise<CenarioVenda> {
        await garantirItemConfiguracao(service, "categorias", "Vestidos");
        await garantirItemConfiguracao(service, "cores", "Azul");
        await garantirItemConfiguracao(service, "tamanhos", "M");
        const produto = await produtosService.criar(payloadProduto(`DET-VENDA-${sufixo}`), null);
        const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
        const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, String(variante._id), {
          tamanho: "M",
          delta: 5,
          exigirExistente: false,
        });
        const vendedor = await moduleRef
          .get(VendedoresService, { strict: false })
          .criar({ nome: `Vendedora Config ${sufixo}`, telefone: `1193${String(Date.now()).slice(-6)}`, ativo: true, senha: "senha123" }, null);
        const caixa = await moduleRef.get(CaixasService, { strict: false }).abrir({ valorInicial: 0 }, null);
        return { produtoId: produto.id, varianteId: String(variante._id), tamanhoId, vendedorId: vendedor.id, caixaId: caixa.id };
      }

      function criarVenda(cenario: CenarioVenda, forma: string) {
        return moduleRef.get(VendasService, { strict: false }).criar(
          {
            vendedorId: cenario.vendedorId,
            caixaId: cenario.caixaId,
            itens: [{ produtoId: cenario.produtoId, varianteId: cenario.varianteId, tamanhoId: cenario.tamanhoId, quantidade: 1 }],
            pagamentos: [{ forma, valor: 100 }],
          },
          null,
        );
      }

      /** Remove só o que este cenário criou (venda, movimentos, caixa, vendedor); o produto sai no afterAll pelo prefixo do nome. */
      async function limparCenario(cenario: CenarioVenda | null, vendaId: string | null): Promise<void> {
        if (vendaId) {
          await connection.collection("vendas").deleteOne({ _id: new Types.ObjectId(vendaId) });
          await connection.collection("eventos_venda").deleteMany({ vendaId: new Types.ObjectId(vendaId) });
        }
        if (!cenario) return;
        const caixaId = new Types.ObjectId(cenario.caixaId);
        await connection.collection("movimentos_caixa").deleteMany({ caixaId });
        await connection.collection("eventos_caixa").deleteMany({ caixaId });
        await connection.collection("caixas").deleteOne({ _id: caixaId });
        await connection.collection("vendedores").deleteOne({ _id: new Types.ObjectId(cenario.vendedorId) });
        await connection.collection("eventos_vendedor").deleteMany({ vendedorId: new Types.ObjectId(cenario.vendedorId) });
      }

      it("garantia (compensação): venda gravada ENTRE o $pull e a rechecagem → a forma é readicionada e a exclusão é rejeitada", async () => {
        const chave = `FormaComp-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        let cenario: CenarioVenda | null = null;
        let vendaId: string | null = null;
        const pausaVenda = novoPonto();
        const pausaExclusao = novoPonto();
        try {
          cenario = await prepararVenda("1");
          const espiaoVenda = pausarInsercaoDeVenda(pausaVenda);
          const espiaoExclusao = pausarExclusaoAntesDaRechecagem(pausaExclusao);
          try {
            const criacao = criarVenda(cenario, chave);
            await pausaVenda.chegou.promessa; // forma já validada por VendasService (e estoque baixado)
            const exclusao = service.removerItem("formasPagamento", chave, USUARIO_ID);
            await pausaExclusao.chegou.promessa;
            expect((await service.obter()).formasPagamento).not.toContain(chave);

            pausaVenda.liberacao.liberar();
            const venda = await criacao; // venda (e movimento de caixa) gravados ANTES da rechecagem
            vendaId = venda.id;
            pausaExclusao.liberacao.liberar();

            await expect(exclusao).rejects.toThrow("Não foi possível excluir esta forma de pagamento porque existem vendas ou movimentações financeiras vinculadas a ela.");
            expect((await service.obter()).formasPagamento).toContain(chave);
            const vendaNoBanco = await connection.collection("vendas").findOne({ _id: new Types.ObjectId(venda.id) });
            expect((vendaNoBanco?.["pagamentos"] as { forma: string }[] | undefined)?.[0]?.forma).toBe(chave);
          } finally {
            liberarTudo(pausaVenda, pausaExclusao);
            espiaoVenda.mockRestore();
            espiaoExclusao.mockRestore();
          }
        } finally {
          await limparCenario(cenario, vendaId);
        }
      });

      it("limitação residual documentada: venda validada ANTES e gravada DEPOIS da rechecagem fica com uma forma não cadastrada", async () => {
        const chave = `FormaResidual-${Date.now()}`;
        await service.adicionarItem("formasPagamento", chave, USUARIO_ID);
        let cenario: CenarioVenda | null = null;
        let vendaId: string | null = null;
        const pausaVenda = novoPonto();
        try {
          cenario = await prepararVenda("2");
          const espiaoVenda = pausarInsercaoDeVenda(pausaVenda);
          try {
            const criacao = criarVenda(cenario, chave);
            await pausaVenda.chegou.promessa;
            // A exclusão inteira não vê venda nem movimento com esta forma.
            expect((await service.removerItem("formasPagamento", chave, USUARIO_ID)).formasPagamento).not.toContain(chave);

            pausaVenda.liberacao.liberar();
            const venda = await criacao;
            vendaId = venda.id;

            // Resultado REAL: venda concluída, com pagamento e movimento de caixa
            // usando uma forma que já não está cadastrada.
            expect((await service.obter()).formasPagamento).not.toContain(chave);
            expect(venda.status).toBe("concluida");
            expect(venda.pagamentos[0]?.forma).toBe(chave);
            const movimentos = await connection.collection("movimentos_caixa").countDocuments({ caixaId: new Types.ObjectId(cenario.caixaId), formaPagamento: chave });
            expect(movimentos).toBe(1);
          } finally {
            liberarTudo(pausaVenda);
            espiaoVenda.mockRestore();
          }
        } finally {
          await limparCenario(cenario, vendaId);
        }
      });
    });
  });

  /**
   * Fase 56.4.1 — compensação robusta da remoção (`removerItemProtegido`).
   *
   * Falhas do MongoDB são INJETADAS por espiões que lançam o erro real do
   * driver (`mongo.MongoNetworkError`) ANTES de chamar o método original (nada
   * gravado) ou DEPOIS (gravado, confirmação perdida) — nenhuma persistência é
   * simulada. O vínculo "na janela" é o mesmo da Fase 56.2: uma variante cuja
   * cor já foi validada é gravada logo depois do `$pull`, antes da rechecagem.
   * Todos os cenários conferem o documento CRU (lista e espelho).
   */
  describe("compensação robusta da remoção (Fase 56.4.1)", () => {
    const MENSAGEM_VINCULO_COR =
      "Não foi possível excluir esta cor porque existem produtos vinculados a ela no sistema. Remova ou altere os vínculos antes de tentar novamente.";
    let repositorio: ConfiguracoesRepository;
    let produtosRepositorio: ProdutosRepository;
    let contador = 0;

    beforeAll(() => {
      repositorio = moduleRef.get(ConfiguracoesRepository, { strict: false });
      produtosRepositorio = moduleRef.get(ProdutosRepository, { strict: false });
    });

    beforeEach(async () => {
      await garantirItemConfiguracao(service, "categorias", "Vestidos");
    });

    function falhaDeRede(): Error {
      return new mongo.MongoNetworkError("falha de rede simulada (teste da Fase 56.4.1)");
    }

    function capturarErro(promessa: Promise<unknown>): Promise<unknown> {
      return promessa.then(
        () => null,
        (erro: unknown) => erro,
      );
    }

    /** Cor nova entre duas vizinhas — `[..., antes, chave, depois]` — para conferir a posição. */
    async function corComVizinhas(rotulo: string) {
      contador += 1;
      const base = `Comp${rotulo}-${Date.now()}-${contador}`;
      const chave = `${base}-Alvo`;
      await service.adicionarItem("cores", `${base}-Antes`, USUARIO_ID);
      await service.adicionarItem("cores", chave, USUARIO_ID);
      await service.adicionarItem("cores", `${base}-Depois`, USUARIO_ID);
      return { chave, antes: `${base}-Antes`, depois: `${base}-Depois` };
    }

    async function coresCruas() {
      const documento = await connection.collection<Configuracao>("configuracoes").findOne({ _id: "global" });
      return { lista: documento?.cores ?? [], espelho: documento?.coresNormalizadas ?? [] };
    }

    /** Quantas vezes o item aparece na lista (por equivalente normalizado) e no espelho, e o índice do valor exato. */
    async function representacao(valor: string) {
      const { lista, espelho } = await coresCruas();
      const normalizado = normalizarCor(valor);
      return {
        naLista: lista.filter((item) => normalizarCor(item) === normalizado).length,
        noEspelho: espelho.filter((item) => item === normalizado).length,
        indice: lista.indexOf(valor),
      };
    }

    /**
     * Inicia `adicionarVariante` com a cor (validada como cadastrada) e pausa
     * antes da gravação. `gravar()` libera e espera a variante ser gravada —
     * chamado DEPOIS do `$pull` (ver `aposPull`), cria o vínculo na janela.
     */
    async function vinculoPendente(chave: string) {
      const produto = await produtosService.criar(payloadProduto(`COMP-${chave}`), null);
      const pausa = novoPonto();
      const original = produtosRepositorio.adicionarVarianteAtomico.bind(produtosRepositorio);
      const espiao = spyOn(produtosRepositorio, "adicionarVarianteAtomico").mockImplementation(async (produtoId, variante) => {
        pausa.chegou.liberar();
        await pausa.liberacao.promessa;
        return original(produtoId, variante);
      });
      const inclusao = produtosService.adicionarVariante(produto.id, { cor: chave }, null);
      inclusao.catch(() => undefined); // se o teste falhar antes de `gravar()`, a rejeição não fica sem tratamento
      await pausa.chegou.promessa;
      espiao.mockRestore(); // a chamada pendente segue no próprio closure
      return {
        gravar: async () => {
          pausa.liberacao.liberar();
          await inclusao;
        },
        liberar: () => liberarTudo(pausa),
      };
    }

    /** `removerItemLista` real; logo depois do `$pull` (antes da rechecagem) roda `acao`. */
    function aposPull(acao: () => Promise<void>) {
      const original = repositorio.removerItemLista.bind(repositorio);
      return spyOn(repositorio, "removerItemLista").mockImplementation(async (campo, valor) => {
        const resultado = await original(campo, valor);
        await acao();
        return resultado;
      });
    }

    /** `falhas[i]` decide a i-ésima chamada de `restaurarItemLista`: "antes" (lança sem gravar), "depois" (grava e lança) ou normal. */
    function restauracaoComFalhas(falhas: ("antes" | "depois")[]) {
      const original = repositorio.restaurarItemLista.bind(repositorio);
      let chamadas = 0;
      const espiao = spyOn(repositorio, "restaurarItemLista").mockImplementation(async (campo, valor, posicao) => {
        const falha = falhas[chamadas];
        chamadas += 1;
        if (falha === "antes") throw falhaDeRede();
        const resultado = await original(campo, valor, posicao);
        if (falha === "depois") throw falhaDeRede();
        return resultado;
      });
      return { espiao, chamadas: () => chamadas };
    }

    /** `listarTodosAtivos` (consulta de vínculo de cor) com falha injetada nas chamadas indicadas (1 = checagem inicial). */
    function consultaDeVinculoComFalhas(falhas: Map<number, () => Error>) {
      const original = produtosRepositorio.listarTodosAtivos.bind(produtosRepositorio);
      let chamadas = 0;
      const espiao = spyOn(produtosRepositorio, "listarTodosAtivos").mockImplementation(async (filtro) => {
        chamadas += 1;
        const falha = falhas.get(chamadas);
        if (falha) throw falha();
        return original(filtro);
      });
      return { espiao, chamadas: () => chamadas };
    }

    function silenciarLogs() {
      return {
        erro: spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
        aviso: spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
      };
    }

    it("1. falha transitória na 1ª restauração e sucesso na 2ª: erro de negócio 400, item de volta na posição original", async () => {
      const { chave, antes, depois } = await corComVizinhas("T1");
      const { indice } = await representacao(chave);
      const vinculo = await vinculoPendente(chave);
      const remocao = aposPull(vinculo.gravar);
      const restauracao = restauracaoComFalhas(["antes"]);
      try {
        const erro = await capturarErro(service.removerItem("cores", chave, USUARIO_ID));
        expect(erro).toBeInstanceOf(ApiException);
        expect(erro instanceof ApiException ? erro.getStatus() : null).toBe(400);
        expect(erro).toMatchObject({ code: "VALIDATION_ERROR", message: MENSAGEM_VINCULO_COR, errors: [{ field: "valor", message: MENSAGEM_VINCULO_COR }] });
        expect(restauracao.chamadas()).toBe(2);
        expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice });
        expect((await coresCruas()).lista.slice(indice - 1, indice + 2)).toEqual([antes, chave, depois]);
      } finally {
        vinculo.liberar();
        remocao.mockRestore();
        restauracao.espiao.mockRestore();
      }
    });

    it("2. falha persistente nas 3 tentativas: HTTP 500 (erro não-ApiException), log contextual completo, nenhum estado inventado", async () => {
      const { chave } = await corComVizinhas("T2");
      const vinculo = await vinculoPendente(chave);
      const remocao = aposPull(vinculo.gravar);
      const restauracao = restauracaoComFalhas(["antes", "antes", "antes"]);
      const logs = silenciarLogs();
      try {
        const erro = await capturarErro(service.removerItem("cores", chave, USUARIO_ID));
        expect(erro).toBeInstanceOf(Error);
        expect(erro).not.toBeInstanceOf(ApiException); // o filtro global responde 500 INTERNAL_ERROR
        expect(erro instanceof Error ? erro.message : "").toBe(`Falha ao restaurar "${chave}" na lista de cores após a remoção.`);
        expect(erro instanceof Error ? erro.cause : null).toBeInstanceOf(mongo.MongoNetworkError);
        expect(restauracao.chamadas()).toBe(3);
        expect(logs.erro).toHaveBeenCalledTimes(1);
        const mensagem = String(logs.erro.mock.calls[0]?.[0]);
        expect(mensagem).toMatch(/operacao=[0-9a-f-]{36} /);
        expect(mensagem).toContain(`lista=cores valor=${JSON.stringify(chave)} normalizado=${JSON.stringify(normalizarCor(chave))}`);
        expect(mensagem).toContain("tentativas=3 motivo=vínculo encontrado na rechecagem");
        expect(mensagem).toContain("erroCompensacao=MongoNetworkError: falha de rede simulada");
        // Estado real (inconsistência que agora fica registrada em log, não escondida):
        expect(await representacao(chave)).toEqual({ naLista: 0, noEspelho: 0, indice: -1 });
      } finally {
        vinculo.liberar();
        remocao.mockRestore();
        restauracao.espiao.mockRestore();
        logs.erro.mockRestore();
        logs.aviso.mockRestore();
      }
    });

    it("3. restauração repetida não duplica: confirmação perdida na 1ª escrita → a 2ª relê e reconhece 'já presente'; chamada extra também", async () => {
      const { chave } = await corComVizinhas("T3");
      const { indice } = await representacao(chave);
      const vinculo = await vinculoPendente(chave);
      const remocao = aposPull(vinculo.gravar);
      const restauracao = restauracaoComFalhas(["depois"]);
      try {
        const erro = await capturarErro(service.removerItem("cores", chave, USUARIO_ID));
        expect(erro).toMatchObject({ code: "VALIDATION_ERROR", message: MENSAGEM_VINCULO_COR });
        expect(restauracao.chamadas()).toBe(2);
        expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice });
      } finally {
        vinculo.liberar();
        remocao.mockRestore();
        restauracao.espiao.mockRestore();
      }
      expect(await repositorio.restaurarItemLista("cores", chave, 0)).toBe("ja_presente");
      expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice });
    });

    it("4. lista e espelho consistentes depois da compensação: o item e as vizinhas aparecem exatamente uma vez em cada um", async () => {
      const { chave, antes, depois } = await corComVizinhas("T4");
      const vinculo = await vinculoPendente(chave);
      const remocao = aposPull(vinculo.gravar);
      try {
        expect(await capturarErro(service.removerItem("cores", chave, USUARIO_ID))).toMatchObject({ message: MENSAGEM_VINCULO_COR });
      } finally {
        vinculo.liberar();
        remocao.mockRestore();
      }
      for (const valor of [antes, chave, depois]) {
        expect(await representacao(valor)).toMatchObject({ naLista: 1, noEspelho: 1 });
      }
    });

    it("5. item ausente na lista mas presente no espelho: a restauração insere na lista (na posição) sem duplicar o espelho", async () => {
      const { chave } = await corComVizinhas("T5");
      const { indice } = await representacao(chave);
      await connection.collection<Configuracao>("configuracoes").updateOne({ _id: "global" }, { $pull: { cores: chave } });
      expect(await representacao(chave)).toEqual({ naLista: 0, noEspelho: 1, indice: -1 });

      expect(await repositorio.restaurarItemLista("cores", chave, indice)).toBe("restaurado");
      expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice });
    });

    it("6. item presente na lista mas ausente no espelho: só o espelho é completado, a lista não muda", async () => {
      const { chave } = await corComVizinhas("T6");
      const { indice } = await representacao(chave);
      await connection.collection<Configuracao>("configuracoes").updateOne({ _id: "global" }, { $pull: { coresNormalizadas: normalizarCor(chave) } });
      const listaAntes = (await coresCruas()).lista;
      expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 0, indice });

      expect(await repositorio.restaurarItemLista("cores", chave, indice)).toBe("espelho_reparado");
      expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice });
      expect((await coresCruas()).lista).toEqual(listaAntes);
    });

    it("7. item presente com grafia diferente e normalizado equivalente: nunca insere a outra grafia (caixa, acento, espaços)", async () => {
      contador += 1;
      const gravado = `Azul  Céu Comp${Date.now()}-${contador}`; // espaço duplo e acento, como foi cadastrado
      const pedido = gravado.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ");
      expect(normalizarCor(pedido)).toBe(normalizarCor(gravado));
      await service.adicionarItem("cores", gravado, USUARIO_ID);
      const listaAntes = (await coresCruas()).lista;

      expect(await repositorio.restaurarItemLista("cores", pedido, 0)).toBe("ja_presente");
      expect((await coresCruas()).lista).toEqual(listaAntes);
      expect(await representacao(pedido)).toMatchObject({ naLista: 1, noEspelho: 1, indice: -1 });

      // Mesmo com o espelho faltando, só o espelho é reparado — a outra grafia continua fora.
      await connection.collection<Configuracao>("configuracoes").updateOne({ _id: "global" }, { $pull: { coresNormalizadas: normalizarCor(gravado) } });
      expect(await repositorio.restaurarItemLista("cores", pedido, 0)).toBe("espelho_reparado");
      expect((await coresCruas()).lista).toEqual(listaAntes);
      expect(await representacao(pedido)).toMatchObject({ naLista: 1, noEspelho: 1, indice: -1 });
    });

    it("8. inclusão concorrente do mesmo item com outra grafia ENTRE a leitura e a escrita da restauração: conflito, releitura, uma única entrada", async () => {
      const { chave } = await corComVizinhas("T8");
      const outraGrafia = chave.toUpperCase();
      const vinculo = await vinculoPendente(chave);
      const remocao = aposPull(vinculo.gravar);
      const restaurarOriginal = repositorio.restaurarItemLista.bind(repositorio);
      const lerOriginal = repositorio.lerEstadoLista.bind(repositorio);
      const resultados: string[] = [];
      let dentroDaRestauracao = false;
      let inclusaoFeita = false;
      const espiaoRestaurar = spyOn(repositorio, "restaurarItemLista").mockImplementation(async (campo, valor, posicao) => {
        dentroDaRestauracao = true;
        try {
          const resultado = await restaurarOriginal(campo, valor, posicao);
          resultados.push(resultado);
          return resultado;
        } finally {
          dentroDaRestauracao = false;
        }
      });
      const espiaoLer = spyOn(repositorio, "lerEstadoLista").mockImplementation(async (campo) => {
        const estado = await lerOriginal(campo);
        if (dentroDaRestauracao && !inclusaoFeita) {
          inclusaoFeita = true;
          await service.adicionarItem("cores", outraGrafia, USUARIO_ID); // escrita concorrente REAL depois da leitura da restauração
        }
        return estado;
      });
      try {
        const erro = await capturarErro(service.removerItem("cores", chave, USUARIO_ID));
        expect(erro).toMatchObject({ code: "VALIDATION_ERROR", message: MENSAGEM_VINCULO_COR });
        expect(resultados).toEqual(["conflito", "ja_presente"]);
        const final = await representacao(chave);
        expect(final).toMatchObject({ naLista: 1, noEspelho: 1, indice: -1 }); // só a grafia concorrente
        expect((await coresCruas()).lista.filter((item) => item === outraGrafia)).toHaveLength(1);
      } finally {
        vinculo.liberar();
        remocao.mockRestore();
        espiaoRestaurar.mockRestore();
        espiaoLer.mockRestore();
      }
    });

    it("9. posição: compensação normal devolve o item ao lugar; posição fora do intervalo (lista mudou) é limitada, nunca inválida", async () => {
      const { chave, antes, depois } = await corComVizinhas("T9");
      const { indice } = await representacao(chave);
      const vinculo = await vinculoPendente(chave);
      const remocao = aposPull(vinculo.gravar);
      try {
        await capturarErro(service.removerItem("cores", chave, USUARIO_ID));
      } finally {
        vinculo.liberar();
        remocao.mockRestore();
      }
      expect((await coresCruas()).lista.slice(indice - 1, indice + 2)).toEqual([antes, chave, depois]);

      const colecao = connection.collection<Configuracao>("configuracoes");
      await colecao.updateOne({ _id: "global" }, { $pull: { cores: chave, coresNormalizadas: normalizarCor(chave) } });
      expect(await repositorio.restaurarItemLista("cores", chave, 1_000_000)).toBe("restaurado");
      const depoisDoFim = await coresCruas();
      expect(depoisDoFim.lista.indexOf(chave)).toBe(depoisDoFim.lista.length - 1);

      await colecao.updateOne({ _id: "global" }, { $pull: { cores: chave, coresNormalizadas: normalizarCor(chave) } });
      expect(await repositorio.restaurarItemLista("cores", chave, -5)).toBe("restaurado");
      expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice: 0 });
    });

    it("10. falha transitória na 2ª checagem: a consulta é repetida e, sem vínculo, a remoção conclui normalmente", async () => {
      const { chave } = await corComVizinhas("T10");
      const consulta = consultaDeVinculoComFalhas(new Map([[2, falhaDeRede]]));
      try {
        const resultado = await service.removerItem("cores", chave, USUARIO_ID);
        expect(resultado.cores).not.toContain(chave);
        expect(consulta.chamadas()).toBe(3); // inicial + rechecagem que falhou + rechecagem repetida
        expect(await representacao(chave)).toEqual({ naLista: 0, noEspelho: 0, indice: -1 });
      } finally {
        consulta.espiao.mockRestore();
      }
    });

    it("11. falha permanente na 2ª checagem: não repete, restaura o item (mesma posição) e propaga o erro original (HTTP 500)", async () => {
      const { chave } = await corComVizinhas("T11");
      const { indice } = await representacao(chave);
      const falhaPermanente = new Error("falha permanente simulada na rechecagem");
      const consulta = consultaDeVinculoComFalhas(new Map([[2, () => falhaPermanente]]));
      const logs = silenciarLogs();
      try {
        const erro = await capturarErro(service.removerItem("cores", chave, USUARIO_ID));
        expect(erro).toBe(falhaPermanente); // nunca convertida em "sem vínculo"
        expect(consulta.chamadas()).toBe(2);
        expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice });
        expect(logs.aviso).toHaveBeenCalledTimes(1);
        expect(String(logs.aviso.mock.calls[0]?.[0])).toContain(`lista=cores valor=${JSON.stringify(chave)} erroOriginal=Error: falha permanente simulada na rechecagem`);
      } finally {
        consulta.espiao.mockRestore();
        logs.erro.mockRestore();
        logs.aviso.mockRestore();
      }
    });

    it("11b. falha transitória esgotada na 2ª checagem (3 tentativas): também restaura e propaga o erro original", async () => {
      const { chave } = await corComVizinhas("T11b");
      const { indice } = await representacao(chave);
      const consulta = consultaDeVinculoComFalhas(new Map([[2, falhaDeRede], [3, falhaDeRede], [4, falhaDeRede]]));
      const logs = silenciarLogs();
      try {
        const erro = await capturarErro(service.removerItem("cores", chave, USUARIO_ID));
        expect(erro).toBeInstanceOf(mongo.MongoNetworkError);
        expect(consulta.chamadas()).toBe(4); // inicial + 3 tentativas da rechecagem
        expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice });
      } finally {
        consulta.espiao.mockRestore();
        logs.erro.mockRestore();
        logs.aviso.mockRestore();
      }
    });

    describe("12. falha ambígua durante o $pull (reconciliação pelo estado persistido)", () => {
      /** `removerItemLista` cuja 1ª chamada falha com erro de rede — `aplicar` decide se o `$pull` chega a ser gravado antes da falha. */
      function remocaoComFalhaAmbigua(aplicar: boolean, depoisDeAplicar: () => Promise<void> = async () => undefined) {
        const original = repositorio.removerItemLista.bind(repositorio);
        let chamadas = 0;
        const espiao = spyOn(repositorio, "removerItemLista").mockImplementation(async (campo, valor) => {
          chamadas += 1;
          if (chamadas > 1) return original(campo, valor);
          if (aplicar) {
            await original(campo, valor);
            await depoisDeAplicar();
          }
          throw falhaDeRede();
        });
        return { espiao, chamadas: () => chamadas };
      }

      it("12a. $pull aplicado e confirmação perdida, sem vínculo: reconhece a remoção sem repetir e conclui com sucesso", async () => {
        const { chave } = await corComVizinhas("T12a");
        const remocao = remocaoComFalhaAmbigua(true);
        try {
          const resultado = await service.removerItem("cores", chave, USUARIO_ID);
          expect(resultado.cores).not.toContain(chave);
          expect(remocao.chamadas()).toBe(1);
          expect(await representacao(chave)).toEqual({ naLista: 0, noEspelho: 0, indice: -1 });
          const eventos = await connection.collection("eventos_configuracao").countDocuments({ tipo: "configuracao.item_removido", "detalhes.valor": chave });
          expect(eventos).toBe(1);
        } finally {
          remocao.espiao.mockRestore();
        }
      });

      it("12b. $pull aplicado e confirmação perdida, com vínculo gravado na janela: reconcilia, recheca, restaura e responde 400", async () => {
        const { chave } = await corComVizinhas("T12b");
        const { indice } = await representacao(chave);
        const vinculo = await vinculoPendente(chave);
        const remocao = remocaoComFalhaAmbigua(true, vinculo.gravar);
        try {
          const erro = await capturarErro(service.removerItem("cores", chave, USUARIO_ID));
          expect(erro).toMatchObject({ code: "VALIDATION_ERROR", message: MENSAGEM_VINCULO_COR });
          expect(remocao.chamadas()).toBe(1);
          expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice });
        } finally {
          vinculo.liberar();
          remocao.espiao.mockRestore();
        }
      });

      it("12c. falha ANTES de gravar: o estado mostra o item ainda presente, então o $pull é repetido e a remoção conclui", async () => {
        const { chave } = await corComVizinhas("T12c");
        const remocao = remocaoComFalhaAmbigua(false);
        try {
          const resultado = await service.removerItem("cores", chave, USUARIO_ID);
          expect(resultado.cores).not.toContain(chave);
          expect(remocao.chamadas()).toBe(2);
          expect(await representacao(chave)).toEqual({ naLista: 0, noEspelho: 0, indice: -1 });
        } finally {
          remocao.espiao.mockRestore();
        }
      });
    });

    it("13. contratos preservados: vínculo na checagem inicial (400, nada gravado) e item inexistente (404) com as mensagens de sempre", async () => {
      const { chave } = await corComVizinhas("T13");
      const { indice } = await representacao(chave);
      const produto = await produtosService.criar(payloadProduto(`COMP-T13-${chave}`), null);
      await produtosService.adicionarVariante(produto.id, { cor: chave }, null);

      const erroVinculo = await capturarErro(service.removerItem("cores", chave, USUARIO_ID));
      expect(erroVinculo instanceof ApiException ? erroVinculo.getStatus() : null).toBe(400);
      expect(erroVinculo).toMatchObject({ code: "VALIDATION_ERROR", message: MENSAGEM_VINCULO_COR, errors: [{ field: "valor", message: MENSAGEM_VINCULO_COR }] });
      expect(await representacao(chave)).toEqual({ naLista: 1, noEspelho: 1, indice });

      const inexistente = `Inexistente-${chave}`;
      const erroNaoEncontrado = await capturarErro(service.removerItem("cores", inexistente, USUARIO_ID));
      expect(erroNaoEncontrado instanceof ApiException ? erroNaoEncontrado.getStatus() : null).toBe(404);
      expect(erroNaoEncontrado).toMatchObject({ code: "NOT_FOUND", message: `"${inexistente}" não existe na lista de cores.`, errors: [] });
    });
  });
});
