import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { mongo, Types, type Connection, type Model } from "mongoose";
import type { ReconciliacaoEstoqueConfig } from "../../config/configuration.js";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ConfiguracoesService } from "../configuracoes/configuracoes.service.js";
import { MovimentacaoEstoque, type MovimentacaoEstoqueDocument } from "../estoque/schemas/movimentacao-estoque.schema.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { Sequencia } from "../sequencias/schemas/sequencia.schema.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { RECONCILIACAO_ESTOQUE_CONFIG } from "./reconciliacao-estoque.config.js";
import { ReconciliacaoEstoqueWorker } from "./reconciliacao-estoque.worker.js";
import type { ResumoRestauracaoVenda } from "./restauracao-estoque.util.js";
import type { VendaDocument } from "./schemas/venda.schema.js";
import { VendasModule } from "./vendas.module.js";
import { VendasRepository } from "./vendas.repository.js";
import { VendasService } from "./vendas.service.js";

/**
 * Fase 60.4.3.4.18 — reconciliação PERSISTENTE de estoque em cancelamentos (integração — MongoDB real).
 *
 * Exige replica set (transações), como toda a suíte de integração no CI (`MONGODB_URI_TESTE` com `replicaSet=rs0`).
 * Falhas são produzidas com ESTADO REAL do banco sempre que possível (produto com saldo que torna a devolução
 * inválida) e, quando o ponto de falha é interno, com espiões na instância EXATA injetada em `VendasService`
 * (`select(VendasModule)`, `strict: true`). "Duas instâncias" = dois contextos Nest independentes, cada um com sua
 * própria conexão MongoDB, sobre o mesmo banco — mesma situação de dois processos da API.
 */

const JWT_MODULO_DE_TESTE = JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });

/** Espera curta e limite baixo para os testes de backoff; worker desligado (os ciclos são acionados explicitamente). */
const CONFIG_TESTE: ReconciliacaoEstoqueConfig = {
  habilitada: false,
  intervaloMs: 60_000,
  loteVendas: 20,
  maxItensPorCiclo: 50,
  maxTentativas: 3,
  esperaBaseMs: 1_000,
  esperaMaximaMs: 4_000,
};

const COLECOES_DO_TESTE = [
  "vendas",
  "eventos_venda",
  "produtos",
  "eventos_produto",
  "vendedores",
  "eventos_vendedor",
  "caixas",
  "movimentos_caixa",
  "eventos_caixa",
  "movimentacoes_estoque",
] as const;

interface Instancia {
  moduleRef: TestingModule;
  service: VendasService;
  worker: ReconciliacaoEstoqueWorker;
  repositorio: VendasRepository;
  ledgerModel: Model<MovimentacaoEstoqueDocument>;
  produtos: ProdutosService;
  caixas: CaixasService;
  vendedores: VendedoresService;
  conexao: Connection;
}

async function criarInstancia(config: ReconciliacaoEstoqueConfig = CONFIG_TESTE): Promise<Instancia> {
  const moduleRef = await Test.createTestingModule({ imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, VendasModule] })
    .overrideProvider(RECONCILIACAO_ESTOQUE_CONFIG)
    .useValue(config)
    .compile();
  const doVendasModule = moduleRef.select(VendasModule);
  return {
    moduleRef,
    service: moduleRef.get(VendasService),
    worker: moduleRef.get(ReconciliacaoEstoqueWorker),
    // `VendasRepository` é provido em 4 módulos: a instância injetada em `VendasService` é a do `VendasModule`.
    repositorio: doVendasModule.get(VendasRepository, { strict: true }),
    ledgerModel: doVendasModule.get<Model<MovimentacaoEstoqueDocument>>(getModelToken(MovimentacaoEstoque.name), { strict: true }),
    produtos: moduleRef.get(ProdutosService),
    caixas: moduleRef.get(CaixasService),
    vendedores: moduleRef.get(VendedoresService),
    conexao: moduleRef.get<Connection>(getConnectionToken()),
  };
}

interface FalhaBruta {
  classe: string;
  codigo: string | null;
  mensagem: string;
  em: Date;
}

interface LinhaBruta {
  itemId: string;
  quantidade: number;
  restaurado?: boolean;
  estadoRestauracao?: string;
  tentativas?: number;
  ultimaTentativaEm?: Date | null;
  proximaTentativaEm?: Date | null;
  restauradoEm?: Date | null;
  ultimaFalha?: FalhaBruta | null;
}

interface VendaBruta {
  _id: Types.ObjectId;
  vendedorId: string;
  cancelamentos?: { _id: Types.ObjectId; itens: LinhaBruta[] }[];
}

let contador = 0;

describe("Reconciliação persistente de estoque em cancelamentos (Fase 60.4.3.4.18 — MongoDB real)", () => {
  let principal: Instancia;
  const extras: Instancia[] = [];
  const espioes: { mockRestore: () => void }[] = [];

  async function limparColecoes(conexao: Connection): Promise<void> {
    for (const nome of COLECOES_DO_TESTE) await conexao.collection(nome).deleteMany({});
    await conexao.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["venda", "produto", "vendedor", "caixa"] } });
  }

  beforeAll(async () => {
    principal = await criarInstancia();
    await limparColecoes(principal.conexao);
    const configuracoes = principal.moduleRef.get(ConfiguracoesService);
    await garantirItemConfiguracao(configuracoes, "cores", "Azul");
    await garantirItemConfiguracao(configuracoes, "tamanhos", "M");
    await garantirItemConfiguracao(configuracoes, "categorias", "Vestidos");
    await garantirItemConfiguracao(configuracoes, "formasPagamento", "Dinheiro");
  });

  afterEach(async () => {
    while (espioes.length) espioes.pop()?.mockRestore();
    while (extras.length) await extras.pop()?.moduleRef.close();
    // Nenhum teste pode deixar caixa aberto (só um caixa aberto por vez, sistema afora).
    const aberto = await principal.caixas.obterAtual();
    if (aberto) await principal.caixas.fechar(aberto.id, { valorInformado: 0 }, null);
    // Isolamento: o worker varre TODAS as vendas; pendências deixadas por um teste não podem entrar no ciclo do próximo.
    await principal.conexao.collection("vendas").deleteMany({});
  });

  afterAll(async () => {
    await limparColecoes(principal.conexao);
    await principal.moduleRef.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Utilitários
  // ---------------------------------------------------------------------------------------------------------------

  async function criarProdutoComEstoque(inst: Instancia, quantidade: number) {
    contador += 1;
    const produto = await inst.produtos.criar({ nome: `Produto Reconciliacao ${contador}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false }, null);
    const variante = await inst.produtos.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const varianteId = String(variante._id);
    const { tamanhoId } = await inst.produtos.ajustarQuantidadeTamanho(produto.id, varianteId, { tamanho: "M", delta: quantidade, exigirExistente: false });
    return { produtoId: produto.id, varianteId, tamanhoId };
  }

  /** Venda com um item por quantidade pedida (cada item em produto próprio, saldo inicial 5). Caixa fica ABERTO. */
  async function prepararVenda(inst: Instancia, quantidades: number[] = [2]) {
    const produtos = [];
    for (const _ of quantidades) produtos.push(await criarProdutoComEstoque(inst, 5));
    contador += 1;
    const vendedor = await inst.vendedores.criar({ nome: `Vendedor Reconciliacao ${contador}`, telefone: `1196${String(contador).padStart(6, "0")}`, ativo: true, senha: "senha123" }, null);
    const caixa = await inst.caixas.abrir({ valorInicial: 1000, observacao: "" }, null);
    const venda = await inst.service.criar(
      {
        vendedorId: vendedor.id,
        caixaId: caixa.id,
        itens: produtos.map((produto, indice) => ({ ...produto, quantidade: quantidades[indice] ?? 1 })),
        pagamentos: [{ forma: "Dinheiro", valor: 100 * quantidades.reduce((total, q) => total + q, 0) }],
      },
      null,
    );
    return { produtos, vendedor, caixa, venda };
  }

  async function saldo(inst: Instancia, produtoId: string): Promise<number> {
    const produto = await inst.produtos.obterPorId(produtoId);
    return produto.variantes[0]!.tamanhos[0]!.quantidade;
  }

  /** Torna a devolução de estoque INVÁLIDA com estado real (saldo resultante negativo é recusado). */
  async function quebrarProduto(conexao: Connection, produtoId: string): Promise<void> {
    await conexao.collection("produtos").updateOne({ _id: new Types.ObjectId(produtoId) }, { $set: { "variantes.0.tamanhos.0.quantidade": -100 } });
  }

  /** "Resolve o problema real": saldo volta a 0 — depois da devolução de 2 unidades, o esperado é exatamente 2. */
  async function consertarProduto(conexao: Connection, produtoId: string): Promise<void> {
    await conexao.collection("produtos").updateOne({ _id: new Types.ObjectId(produtoId) }, { $set: { "variantes.0.tamanhos.0.quantidade": 0 } });
  }

  async function vendaBruta(conexao: Connection, vendaId: string): Promise<VendaBruta> {
    const doc = await conexao.collection<VendaBruta>("vendas").findOne({ _id: new Types.ObjectId(vendaId) });
    if (!doc) throw new Error(`venda ${vendaId} não encontrada`);
    return doc;
  }

  async function linhas(conexao: Connection, vendaId: string): Promise<LinhaBruta[]> {
    return ((await vendaBruta(conexao, vendaId)).cancelamentos ?? []).flatMap((evento) => evento.itens);
  }

  async function primeiraLinha(conexao: Connection, vendaId: string): Promise<LinhaBruta> {
    const [linha] = await linhas(conexao, vendaId);
    if (!linha) throw new Error("venda sem linhas de cancelamento");
    return linha;
  }

  async function entradasNoLedger(conexao: Connection, vendaId: string, produtoId?: string): Promise<number> {
    return conexao
      .collection("movimentacoes_estoque")
      .countDocuments({ vendaId, origem: "cancelamento", tipo: "entrada", ...(produtoId ? { produtoId: new Types.ObjectId(produtoId) } : {}) });
  }

  async function venceAgenda(conexao: Connection, vendaId: string): Promise<void> {
    await conexao
      .collection("vendas")
      .updateOne({ _id: new Types.ObjectId(vendaId) }, { $set: { "cancelamentos.$[].itens.$[].proximaTentativaEm": new Date(Date.now() - 1_000) } });
  }

  function resumoSerializado(venda: VendaDocument): ResumoRestauracaoVenda {
    const json = JSON.parse(JSON.stringify(venda)) as { restauracaoEstoque: ResumoRestauracaoVenda };
    return json.restauracaoEstoque;
  }

  /** Cancela (integral, com chave) com o produto quebrado: a venda fica cancelada e a linha com restauração pendente. */
  async function cancelarComFalhaDeRestauracao(inst: Instancia) {
    const cenario = await prepararVenda(inst);
    const produtoId = cenario.produtos[0]!.produtoId;
    await quebrarProduto(inst.conexao, produtoId);
    const chave = `reconciliacao-${Date.now()}-${contador}`;
    const cancelada = await inst.service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Teste reconciliação", idempotencyKey: chave }, null);
    await inst.caixas.fechar(cenario.caixa.id, { valorInformado: 0 }, null);
    return { ...cenario, produtoId, chave, cancelada };
  }

  function erroTransitorio(): mongo.MongoServerError {
    const erro = new mongo.MongoServerError({ message: "[INJETADO] WriteConflict simulado", code: 112, codeName: "WriteConflict" });
    erro.addErrorLabel("TransientTransactionError");
    return erro;
  }

  function erroCommitAmbiguo(): mongo.MongoServerError {
    const erro = new mongo.MongoServerError({ message: "[INJETADO] resultado do commit desconhecido", code: 50, codeName: "MaxTimeMSExpired" });
    erro.addErrorLabel("UnknownTransactionCommitResult");
    return erro;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Estado persistido e resposta da API
  // ---------------------------------------------------------------------------------------------------------------

  describe("cancelamento com falha de restauração", () => {
    it("a venda é cancelada, a linha fica PERSISTIDA como falha_recuperavel (tentativas, agenda, falha segura) e a resposta diz `pendente`", async () => {
      const { cancelada, venda, produtoId } = await cancelarComFalhaDeRestauracao(principal);

      expect(cancelada.status).toBe("cancelada");
      const resumo = resumoSerializado(cancelada);
      expect(resumo.status).toBe("pendente");
      expect(resumo).toMatchObject({ totalItens: 1, concluidos: 0, emFalhaRecuperavel: 1 });
      expect(resumo.proximaTentativaEm).not.toBeNull();

      const linha = await primeiraLinha(principal.conexao, venda.id);
      expect(linha.restaurado).toBe(false);
      expect(linha.estadoRestauracao).toBe("falha_recuperavel");
      expect(linha.tentativas).toBe(1);
      expect(linha.ultimaTentativaEm).toBeInstanceOf(Date);
      expect(linha.proximaTentativaEm!.getTime() - linha.ultimaTentativaEm!.getTime()).toBe(CONFIG_TESTE.esperaBaseMs);
      expect(linha.ultimaFalha?.classe).toBe("ApiException");
      expect(JSON.stringify(linha.ultimaFalha)).not.toContain("    at ");
      expect(await entradasNoLedger(principal.conexao, venda.id)).toBe(0);
      expect(await saldo(principal, produtoId)).toBe(-100); // nada foi devolvido
    });

    it("cancelamento bem-sucedido grava `concluida`, `restauradoEm`, 1 tentativa e responde `concluida`", async () => {
      const cenario = await prepararVenda(principal);
      const cancelada = await principal.service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Sucesso", idempotencyKey: `ok-${Date.now()}` }, null);
      await principal.caixas.fechar(cenario.caixa.id, { valorInformado: 0 }, null);

      expect(resumoSerializado(cancelada).status).toBe("concluida");
      const linha = await primeiraLinha(principal.conexao, cenario.venda.id);
      expect(linha).toMatchObject({ restaurado: true, estadoRestauracao: "concluida", tentativas: 1, proximaTentativaEm: null, ultimaFalha: null });
      expect(linha.restauradoEm).toBeInstanceOf(Date);
      expect(await saldo(principal, cenario.produtos[0]!.produtoId)).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Worker: recuperação, backoff, limite, restart, concorrência
  // ---------------------------------------------------------------------------------------------------------------

  describe("reconciliação automática (worker)", () => {
    it("recuperação básica: depois de resolvido o problema e vencida a agenda, um ciclo devolve o estoque UMA vez, sem novo evento/caixa", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(principal);
      const movimentosCaixaAntes = await principal.conexao.collection("movimentos_caixa").countDocuments({ vendaId: venda.id });
      const eventosAntes = await principal.conexao.collection("eventos_venda").countDocuments({ vendaId: venda.id });

      await consertarProduto(principal.conexao, produtoId);
      await venceAgenda(principal.conexao, venda.id);
      const ciclo = await principal.worker.executarCiclo();

      expect(ciclo).toMatchObject({ concluidas: 1, falhas: 0 });
      expect(await saldo(principal, produtoId)).toBe(2);
      expect(await entradasNoLedger(principal.conexao, venda.id)).toBe(1);
      expect(await primeiraLinha(principal.conexao, venda.id)).toMatchObject({ restaurado: true, estadoRestauracao: "concluida", tentativas: 2, ultimaFalha: null });
      expect(await principal.conexao.collection("movimentos_caixa").countDocuments({ vendaId: venda.id })).toBe(movimentosCaixaAntes);
      expect(await principal.conexao.collection("eventos_venda").countDocuments({ vendaId: venda.id })).toBe(eventosAntes);
      expect((await vendaBruta(principal.conexao, venda.id)).cancelamentos).toHaveLength(1);

      // Ciclo seguinte: nada mais a fazer.
      expect(await principal.worker.executarCiclo()).toMatchObject({ tentadas: 0 });
      expect(await saldo(principal, produtoId)).toBe(2);
    });

    it("respeita o backoff: ciclos repetidos antes da agenda não tentam (sem laço agressivo) e a espera dobra a cada falha", async () => {
      const { venda } = await cancelarComFalhaDeRestauracao(principal);

      for (let i = 0; i < 5; i += 1) {
        expect(await principal.worker.executarCiclo()).toMatchObject({ tentadas: 0 });
      }
      expect((await primeiraLinha(principal.conexao, venda.id)).tentativas).toBe(1);

      await venceAgenda(principal.conexao, venda.id);
      expect(await principal.worker.executarCiclo()).toMatchObject({ tentadas: 1, falhas: 1 });
      const linha = await primeiraLinha(principal.conexao, venda.id);
      expect(linha.tentativas).toBe(2);
      expect(linha.estadoRestauracao).toBe("falha_recuperavel");
      expect(linha.proximaTentativaEm!.getTime() - linha.ultimaTentativaEm!.getTime()).toBe(CONFIG_TESTE.esperaBaseMs * 2);
    });

    it("falha persistente: ao atingir o limite vira `requer_intervencao`, o worker para de tentar e a API sinaliza; o operador conclui depois", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(principal);

      for (let tentativa = 2; tentativa <= CONFIG_TESTE.maxTentativas; tentativa += 1) {
        await venceAgenda(principal.conexao, venda.id);
        await principal.worker.executarCiclo();
      }
      let linha = await primeiraLinha(principal.conexao, venda.id);
      expect(linha.tentativas).toBe(CONFIG_TESTE.maxTentativas);
      expect(linha.estadoRestauracao).toBe("requer_intervencao");
      expect(linha.proximaTentativaEm).toBeNull();

      // Mesmo com a agenda "vencida", o worker não toca uma linha que requer intervenção.
      await venceAgenda(principal.conexao, venda.id);
      expect(await principal.worker.executarCiclo()).toMatchObject({ tentadas: 0 });
      expect((await primeiraLinha(principal.conexao, venda.id)).tentativas).toBe(CONFIG_TESTE.maxTentativas);

      const detalhe = await principal.service.obterPorId(venda.id);
      expect(resumoSerializado(detalhe).status).toBe("requer_intervencao");
      const pendencias = await principal.service.listarPendenciasDeRestauracao(100);
      const pendencia = pendencias.itens.find((item) => item.vendaId === venda.id);
      expect(pendencia).toMatchObject({ estado: "requer_intervencao", tentativas: CONFIG_TESTE.maxTentativas, quantidade: 2 });
      expect(pendencia?.ultimaFalha?.classe).toBe("ApiException");

      // Operador: resolve a causa e solicita a reconciliação (sem repetir o cancelamento, sem chave nova).
      await consertarProduto(principal.conexao, produtoId);
      const reconciliada = await principal.service.reconciliarRestauracaoEstoque(venda.id, null);
      expect(resumoSerializado(reconciliada).status).toBe("concluida");
      linha = await primeiraLinha(principal.conexao, venda.id);
      expect(linha).toMatchObject({ restaurado: true, estadoRestauracao: "concluida" });
      expect(await saldo(principal, produtoId)).toBe(2);
      expect(await entradasNoLedger(principal.conexao, venda.id)).toBe(1);
      expect((await principal.service.listarPendenciasDeRestauracao(100)).itens.some((item) => item.vendaId === venda.id)).toBe(false);
    });

    it("restart: a pendência criada por uma instância destruída é concluída por um contexto Nest NOVO (descoberta pelo banco, não pela memória)", async () => {
      const antiga = await criarInstancia();
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(antiga);
      await antiga.moduleRef.close();

      const nova = await criarInstancia();
      extras.push(nova);
      await consertarProduto(nova.conexao, produtoId);
      await venceAgenda(nova.conexao, venda.id);
      expect(await nova.worker.executarCiclo()).toMatchObject({ concluidas: 1 });
      expect(await saldo(nova, produtoId)).toBe(2);
      expect(await entradasNoLedger(nova.conexao, venda.id)).toBe(1);
    }, 30_000);

    it("concorrência entre DUAS instâncias (workers + reconciliação manual simultâneos): o estoque volta exatamente uma vez", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(principal);
      const outra = await criarInstancia();
      extras.push(outra);
      await consertarProduto(principal.conexao, produtoId);
      await venceAgenda(principal.conexao, venda.id);

      await Promise.allSettled([
        principal.worker.executarCiclo(),
        outra.worker.executarCiclo(),
        principal.service.reconciliarRestauracaoEstoque(venda.id, null),
        outra.service.reconciliarRestauracaoEstoque(venda.id, null),
        outra.worker.executarCiclo(),
      ]);

      expect(await saldo(principal, produtoId)).toBe(2); // nunca 4 ou mais
      expect(await entradasNoLedger(principal.conexao, venda.id)).toBe(1);
      const linha = await primeiraLinha(principal.conexao, venda.id);
      expect(linha.restaurado).toBe(true);
      expect(linha.tentativas).toBe(2); // 1 falha original + 1 sucesso — nenhuma contagem duplicada
    }, 30_000);

    it("o mesmo worker nunca roda dois ciclos sobrepostos na mesma instância", async () => {
      const primeiro = principal.worker.executarCiclo();
      const segundo = principal.worker.executarCiclo();
      expect(segundo).toBe(primeiro);
      await primeiro;
    });

    it("habilitado, o worker é iniciado no bootstrap da aplicação, conclui uma pendência sozinho pelo temporizador e para no shutdown", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(principal);
      await consertarProduto(principal.conexao, produtoId);
      await venceAgenda(principal.conexao, venda.id);

      const comWorker = await criarInstancia({ ...CONFIG_TESTE, habilitada: true, intervaloMs: 100 });
      await comWorker.moduleRef.init(); // dispara `onApplicationBootstrap`, como a aplicação real
      expect(comWorker.worker.ativo).toBe(true);
      const limite = Date.now() + 10_000;
      while (Date.now() < limite && (await primeiraLinha(principal.conexao, venda.id)).restaurado !== true) {
        await new Promise((resolver) => setTimeout(resolver, 100));
      }
      await comWorker.moduleRef.close();
      expect(comWorker.worker.ativo).toBe(false);
      expect(await saldo(principal, produtoId)).toBe(2);
      expect(await entradasNoLedger(principal.conexao, venda.id)).toBe(1);
    }, 30_000);

    it("desabilitado (padrão em teste), o bootstrap NÃO agenda ciclos", async () => {
      const semWorker = await criarInstancia();
      extras.push(semWorker);
      await semWorker.moduleRef.init();
      expect(semWorker.worker.ativo).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Pontos de falha dentro da transação
  // ---------------------------------------------------------------------------------------------------------------

  describe("falhas em cada ponto da transação de restauração: nada parcial é confirmado", () => {
    it("falha no LEDGER: a devolução física é desfeita junto (abort), a linha fica pendente e a nova tentativa conclui", async () => {
      const cenario = await prepararVenda(principal);
      const produtoId = cenario.produtos[0]!.produtoId;
      espioes.push(
        spyOn(principal.ledgerModel, "create").mockImplementationOnce(async () => {
          throw new Error("[INJETADO] falha ao gravar o ledger");
        }),
      );
      const cancelada = await principal.service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Ledger", idempotencyKey: `ledger-${Date.now()}` }, null);
      await principal.caixas.fechar(cenario.caixa.id, { valorInformado: 0 }, null);

      expect(resumoSerializado(cancelada).status).toBe("pendente");
      expect(await saldo(principal, produtoId)).toBe(3); // a devolução da transação abortada não ficou
      expect(await entradasNoLedger(principal.conexao, cenario.venda.id)).toBe(0);
      expect(await primeiraLinha(principal.conexao, cenario.venda.id)).toMatchObject({ restaurado: false, estadoRestauracao: "falha_recuperavel", tentativas: 1 });

      await principal.service.reconciliarRestauracaoEstoque(cenario.venda.id, null);
      expect(await saldo(principal, produtoId)).toBe(5);
      expect(await entradasNoLedger(principal.conexao, cenario.venda.id)).toBe(1);
    });

    it("falha ao MARCAR a linha: estoque e ledger da tentativa são desfeitos; a nova tentativa devolve uma única vez", async () => {
      const cenario = await prepararVenda(principal);
      const produtoId = cenario.produtos[0]!.produtoId;
      espioes.push(
        spyOn(principal.repositorio, "marcarItemRestaurado").mockImplementationOnce(async () => {
          throw new Error("[INJETADO] falha ao marcar a linha");
        }),
      );
      await principal.service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Marcar", idempotencyKey: `marcar-${Date.now()}` }, null);
      await principal.caixas.fechar(cenario.caixa.id, { valorInformado: 0 }, null);

      expect(await saldo(principal, produtoId)).toBe(3);
      expect(await entradasNoLedger(principal.conexao, cenario.venda.id)).toBe(0);
      expect((await primeiraLinha(principal.conexao, cenario.venda.id)).estadoRestauracao).toBe("falha_recuperavel");

      await venceAgenda(principal.conexao, cenario.venda.id);
      await principal.worker.executarCiclo();
      expect(await saldo(principal, produtoId)).toBe(5);
      expect(await entradasNoLedger(principal.conexao, cenario.venda.id)).toBe(1);
    });

    it("erro TRANSITÓRIO (WriteConflict / TransientTransactionError): a transação inteira é repetida na mesma chamada e conclui sem registrar falha", async () => {
      const cenario = await prepararVenda(principal);
      const produtoId = cenario.produtos[0]!.produtoId;
      espioes.push(
        spyOn(principal.repositorio, "marcarItemRestaurado").mockImplementationOnce(async () => {
          throw erroTransitorio();
        }),
      );
      const cancelada = await principal.service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Transitório", idempotencyKey: `transitorio-${Date.now()}` }, null);
      await principal.caixas.fechar(cenario.caixa.id, { valorInformado: 0 }, null);

      expect(resumoSerializado(cancelada).status).toBe("concluida");
      expect(await saldo(principal, produtoId)).toBe(5); // nunca 7: a 1ª tentativa (abortada) não deixou devolução
      expect(await entradasNoLedger(principal.conexao, cenario.venda.id)).toBe(1);
      expect(await primeiraLinha(principal.conexao, cenario.venda.id)).toMatchObject({ estadoRestauracao: "concluida", tentativas: 1, ultimaFalha: null });
    });

    it("commit AMBÍGUO (aplicado no servidor, cliente recebe UnknownTransactionCommitResult até esgotar): nenhuma devolução dupla e nenhuma falha falsa registrada", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(principal);
      await consertarProduto(principal.conexao, produtoId);

      const commitOriginal = mongo.ClientSession.prototype.commitTransaction;
      espioes.push(
        spyOn(mongo.ClientSession.prototype, "commitTransaction").mockImplementation(async function (this: mongo.ClientSession) {
          await commitOriginal.call(this);
          throw erroCommitAmbiguo();
        }),
      );
      await principal.service.reconciliarRestauracaoEstoque(venda.id, null);
      espioes.pop()?.mockRestore();

      expect(await saldo(principal, produtoId)).toBe(2); // aplicado UMA vez
      expect(await entradasNoLedger(principal.conexao, venda.id)).toBe(1);
      const linha = await primeiraLinha(principal.conexao, venda.id);
      expect(linha).toMatchObject({ restaurado: true, estadoRestauracao: "concluida", tentativas: 2 }); // CAS da falha não casou

      // Uma nova reconciliação lê o estado real e não devolve de novo.
      await principal.service.reconciliarRestauracaoEstoque(venda.id, null);
      expect(await saldo(principal, produtoId)).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Compatibilidade com dados legados e eventos parcialmente restaurados
  // ---------------------------------------------------------------------------------------------------------------

  describe("compatibilidade com eventos legados (sem migração)", () => {
    /** Cancela normalmente e então reescreve a linha no formato legado, desfazendo (quando pedido) a devolução. */
    async function linhaLegada(formato: "true" | "false" | "ausente") {
      const cenario = await prepararVenda(principal);
      const produtoId = cenario.produtos[0]!.produtoId;
      await principal.service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Legado", idempotencyKey: `legado-${formato}-${Date.now()}` }, null);
      await principal.caixas.fechar(cenario.caixa.id, { valorInformado: 0 }, null);
      const camposNovos = { estadoRestauracao: "", tentativas: "", ultimaTentativaEm: "", proximaTentativaEm: "", restauradoEm: "", ultimaFalha: "" };
      const unset = Object.fromEntries(Object.keys(camposNovos).map((campo) => [`cancelamentos.$[].itens.$[].${campo}`, ""]));
      if (formato === "true") {
        await principal.conexao.collection("vendas").updateOne({ _id: new Types.ObjectId(cenario.venda.id) }, { $unset: unset });
      } else {
        // Simula restauração nunca feita: desfaz estoque e ledger.
        await principal.conexao.collection("produtos").updateOne({ _id: new Types.ObjectId(produtoId) }, { $inc: { "variantes.0.tamanhos.0.quantidade": -2 } });
        await principal.conexao.collection("movimentacoes_estoque").deleteMany({ vendaId: cenario.venda.id, origem: "cancelamento" });
        if (formato === "false") {
          await principal.conexao
            .collection("vendas")
            .updateOne({ _id: new Types.ObjectId(cenario.venda.id) }, { $unset: unset, $set: { "cancelamentos.$[].itens.$[].restaurado": false } });
        } else {
          await principal.conexao
            .collection("vendas")
            .updateOne({ _id: new Types.ObjectId(cenario.venda.id) }, { $unset: { ...unset, "cancelamentos.$[].itens.$[].restaurado": "" } });
        }
      }
      return { ...cenario, produtoId };
    }

    it("`restaurado: true` sem os campos novos: lido como concluído; o worker não devolve de novo", async () => {
      const { venda, produtoId } = await linhaLegada("true");
      const linha = await primeiraLinha(principal.conexao, venda.id);
      expect(linha.estadoRestauracao).toBeUndefined();
      expect(resumoSerializado(await principal.service.obterPorId(venda.id)).status).toBe("concluida");
      await principal.worker.executarCiclo();
      expect(await saldo(principal, produtoId)).toBe(5);
      expect(await entradasNoLedger(principal.conexao, venda.id)).toBe(1);
    });

    it("`restaurado: false` sem os campos novos: pendente e elegível; o worker conclui uma vez", async () => {
      const { venda, produtoId } = await linhaLegada("false");
      expect(resumoSerializado(await principal.service.obterPorId(venda.id)).status).toBe("pendente");
      expect(await principal.worker.executarCiclo()).toMatchObject({ concluidas: 1 });
      expect(await saldo(principal, produtoId)).toBe(5);
      expect(await entradasNoLedger(principal.conexao, venda.id)).toBe(1);
      expect((await primeiraLinha(principal.conexao, venda.id)).tentativas).toBe(1);
    });

    it("`restaurado` AUSENTE: NUNCA tratado como concluído — pendente, elegível e concluído pelo worker", async () => {
      const { venda, produtoId } = await linhaLegada("ausente");
      expect((await primeiraLinha(principal.conexao, venda.id)).restaurado).toBeUndefined();
      expect(resumoSerializado(await principal.service.obterPorId(venda.id)).status).toBe("pendente");
      expect((await principal.service.listarPendenciasDeRestauracao(100)).itens.some((item) => item.vendaId === venda.id && item.estado === "pendente")).toBe(true);
      expect(await principal.worker.executarCiclo()).toMatchObject({ concluidas: 1 });
      expect(await saldo(principal, produtoId)).toBe(5);
      expect((await primeiraLinha(principal.conexao, venda.id)).restaurado).toBe(true);
    });

    it("evento PARCIALMENTE restaurado: só a linha pendente é devolvida; a concluída não é tocada", async () => {
      const cenario = await prepararVenda(principal, [2, 1]);
      const [produtoA, produtoB] = cenario.produtos;
      await principal.service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Parcial", idempotencyKey: `parcial-${Date.now()}` }, null);
      await principal.caixas.fechar(cenario.caixa.id, { valorInformado: 0 }, null);
      // Desfaz SÓ a linha B (como se tivesse falhado).
      await principal.conexao.collection("produtos").updateOne({ _id: new Types.ObjectId(produtoB!.produtoId) }, { $inc: { "variantes.0.tamanhos.0.quantidade": -1 } });
      await principal.conexao.collection("movimentacoes_estoque").deleteMany({ vendaId: cenario.venda.id, produtoId: new Types.ObjectId(produtoB!.produtoId) });
      await principal.conexao
        .collection("vendas")
        .updateOne(
          { _id: new Types.ObjectId(cenario.venda.id) },
          { $set: { "cancelamentos.0.itens.1.restaurado": false, "cancelamentos.0.itens.1.estadoRestauracao": "pendente" } },
        );
      expect(resumoSerializado(await principal.service.obterPorId(cenario.venda.id))).toMatchObject({ status: "pendente", concluidos: 1, pendentes: 1 });

      expect(await principal.worker.executarCiclo()).toMatchObject({ tentadas: 1, concluidas: 1 });
      expect(await saldo(principal, produtoA!.produtoId)).toBe(5);
      expect(await saldo(principal, produtoB!.produtoId)).toBe(5);
      expect(await entradasNoLedger(principal.conexao, cenario.venda.id, produtoA!.produtoId)).toBe(1);
      expect(await entradasNoLedger(principal.conexao, cenario.venda.id, produtoB!.produtoId)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Repetição do cancelamento (Backoffice)
  // ---------------------------------------------------------------------------------------------------------------

  describe("repetição do cancelamento", () => {
    it("MESMA chave com restauração pendente: conclui o estoque sem novo evento, sem novo movimento de caixa e sem nova reversão de agregados", async () => {
      const { venda, produtoId, chave } = await cancelarComFalhaDeRestauracao(principal);
      const vendedorAntes = await principal.conexao.collection("vendedores").findOne({ _id: new Types.ObjectId(venda.vendedorId) });
      const movimentosAntes = await principal.conexao.collection("movimentos_caixa").countDocuments({ vendaId: venda.id });
      const eventosAntes = await principal.conexao.collection("eventos_venda").countDocuments({ vendaId: venda.id });
      await consertarProduto(principal.conexao, produtoId);

      const caixa = await principal.caixas.abrir({ valorInicial: 1000, observacao: "" }, null); // replay exige caixa aberto
      const repetida = await principal.service.cancelar(venda.id, { tipo: "integral", motivo: "Repetição", idempotencyKey: chave }, null);
      await principal.caixas.fechar(caixa.id, { valorInformado: 0 }, null);

      expect(resumoSerializado(repetida).status).toBe("concluida");
      expect(await saldo(principal, produtoId)).toBe(2);
      expect(await entradasNoLedger(principal.conexao, venda.id)).toBe(1);
      expect((await vendaBruta(principal.conexao, venda.id)).cancelamentos).toHaveLength(1);
      expect(await principal.conexao.collection("movimentos_caixa").countDocuments({ vendaId: venda.id })).toBe(movimentosAntes);
      expect(await principal.conexao.collection("eventos_venda").countDocuments({ vendaId: venda.id })).toBe(eventosAntes);
      expect(await principal.conexao.collection("vendedores").findOne({ _id: new Types.ObjectId(venda.vendedorId) })).toEqual(vendedorAntes);
    });

    it("chave DIFERENTE numa venda já cancelada: rejeitada como antes, sem nenhuma alteração", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(principal);
      const antes = await vendaBruta(principal.conexao, venda.id);
      const caixa = await principal.caixas.abrir({ valorInicial: 1000, observacao: "" }, null);
      try {
        await expect(principal.service.cancelar(venda.id, { tipo: "integral", motivo: "Outra chave", idempotencyKey: `outra-${Date.now()}` }, null)).rejects.toThrow(
          "Esta venda já está cancelada.",
        );
      } finally {
        await principal.caixas.fechar(caixa.id, { valorInformado: 0 }, null);
      }
      expect(await vendaBruta(principal.conexao, venda.id)).toEqual(antes);
      expect(await saldo(principal, produtoId)).toBe(-100);
    });
  });
});
