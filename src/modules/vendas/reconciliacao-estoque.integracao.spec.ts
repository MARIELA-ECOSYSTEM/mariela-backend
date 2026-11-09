import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { Logger } from "@nestjs/common";
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
import { VendasService, type ResultadoCicloReconciliacao } from "./vendas.service.js";

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
  // Fase 60.4.3.4.18.3 — se algo falhar DEPOIS de compilar (contexto parcialmente inicializado), fecha o contexto
  // (e sua conexão) antes de propagar o erro: nada fica aberto prendendo o processo de teste.
  try {
    const conexao = moduleRef.get<Connection>(getConnectionToken());
    return {
      moduleRef,
      service: moduleRef.get(VendasService),
      worker: moduleRef.get(ReconciliacaoEstoqueWorker),
      // `VendasRepository` é provido em 4 módulos: a instância injetada em `VendasService` é a do `VendasModule`.
      repositorio: moduleRef.select(VendasModule).get(VendasRepository, { strict: true }),
      // Fase 60.4.3.4.18.3 — CORREÇÃO do setup (falha 1 do CI de `78194a7`): o provider do model mora no módulo
      // dinâmico do `MongooseModule.forFeature` (só EXPORTADO para `VendasModule`), então `select(VendasModule)` com
      // `strict: true` não o encontra. O factory do `@nestjs/mongoose` reaproveita `connection.models[nome]`: o model
      // registrado na conexão é o MESMO objeto injetado em `VendasService` (conferido no teste "setup").
      ledgerModel: conexao.model<MovimentacaoEstoqueDocument>(MovimentacaoEstoque.name),
      produtos: moduleRef.get(ProdutosService),
      caixas: moduleRef.get(CaixasService),
      vendedores: moduleRef.get(VendedoresService),
      conexao,
    };
  } catch (erro) {
    await moduleRef.close();
    throw erro;
  }
}

/**
 * Fase 60.4.3.4.18.6A — fecha um caixa com o saldo ESPERADO real, sem diferença artificial.
 * `CaixasService.fechar` recusa diferença ≥ tolerância sem justificativa, e o antigo `valorInformado: 0` era sempre
 * recusado (esperado 1000), deixando o caixa aberto e derrubando todo `caixas.abrir` seguinte. O valor vem de
 * `obterDetalhe(id).resumo.saldoEsperado`: a MESMA função (`calcularResumo`) sobre as MESMAS movimentações
 * (`listarTodosPorCaixa`) que o próprio `fechar` usa para conferir. Nenhum erro é engolido.
 */
async function fecharCaixa(inst: Instancia, caixaId: string): Promise<void> {
  const detalhe = await inst.caixas.obterDetalhe(caixaId);
  await inst.caixas.fechar(caixaId, { valorInformado: detalhe.resumo.saldoEsperado }, null);
}

/**
 * Fase 60.4.3.4.18.3 — encerra um contexto SÓ se ele chegou a existir. Usado no `afterAll`: se o `beforeAll` falhar,
 * a falha original é a única reportada (sem uma segunda falha por acesso a `undefined`, como a falha 2 do CI).
 */
async function encerrarInstancia(inst: Instancia | undefined, limpar?: (conexao: Connection) => Promise<void>): Promise<void> {
  if (!inst) return;
  try {
    if (limpar) await limpar(inst.conexao);
  } finally {
    await inst.moduleRef.close();
  }
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
  // `undefined` até o `beforeAll` concluir — os hooks de limpeza checam antes de usar.
  let principal: Instancia | undefined;
  /** Contexto principal, já inicializado (os testes só rodam se o `beforeAll` concluiu). */
  function p(): Instancia {
    if (!principal) throw new Error("[SETUP] contexto principal não inicializado (o beforeAll falhou)");
    return principal;
  }
  const extras: Instancia[] = [];
  const espioes: { mockRestore: () => void }[] = [];

  async function limparColecoes(conexao: Connection): Promise<void> {
    for (const nome of COLECOES_DO_TESTE) await conexao.collection(nome).deleteMany({});
    await conexao.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["venda", "produto", "vendedor", "caixa"] } });
  }

  beforeAll(async () => {
    const inst = await criarInstancia();
    principal = inst;
    await limparColecoes(inst.conexao);
    const configuracoes = inst.moduleRef.get(ConfiguracoesService);
    await garantirItemConfiguracao(configuracoes, "cores", "Azul");
    await garantirItemConfiguracao(configuracoes, "tamanhos", "M");
    await garantirItemConfiguracao(configuracoes, "categorias", "Vestidos");
    await garantirItemConfiguracao(configuracoes, "formasPagamento", "Dinheiro");
  });

  afterEach(async () => {
    while (espioes.length) espioes.pop()?.mockRestore();
    while (extras.length) await extras.pop()?.moduleRef.close();
    if (!principal) return;
    // Nenhum teste pode deixar caixa aberto (só um caixa aberto por vez, sistema afora).
    // Fase 60.4.3.4.18.6A — fecha com o valor ESPERADO real (`fecharCaixa`). Se o fechamento falhar, a falha é
    // PROPAGADA (o Bun a reporta neste teste) com a indicação explícita de que o caixa ficou aberto — nunca ignorada.
    const aberto = await principal.caixas.obterAtual();
    if (aberto) {
      try {
        await fecharCaixa(principal, aberto.id);
      } catch (erro) {
        throw new Error(
          `[LIMPEZA] não foi possível fechar o caixa ${aberto.id}; ele PERMANECEU ABERTO e os testes seguintes que abrem caixa vão falhar. Causa: ${erro instanceof Error ? erro.message : String(erro)}`,
          { cause: erro },
        );
      }
    }
    // Isolamento: o worker varre TODAS as vendas; pendências deixadas por um teste não podem entrar no ciclo do próximo.
    await principal.conexao.collection("vendas").deleteMany({});
  });

  afterAll(async () => {
    // Fase 60.4.3.4.18.3 — CORREÇÃO (falha 2 do CI de `78194a7`): só encerra o que foi inicializado.
    await encerrarInstancia(principal, limparColecoes);
  });

  describe("setup (Fase 60.4.3.4.18.3)", () => {
    it("o model do ledger usado pelos testes é o MESMO objeto injetado no domínio (provider do `forFeature`)", () => {
      const inst = p();
      const doProvider = inst.moduleRef.get<Model<MovimentacaoEstoqueDocument>>(getModelToken(MovimentacaoEstoque.name), { strict: false });
      expect(inst.ledgerModel).toBe(doProvider);
      expect(inst.ledgerModel.collection.collectionName).toBe("movimentacoes_estoque");
    });

    it("encerramento seguro: sem contexto inicializado (beforeAll falhou) não lança nem acessa `undefined`", async () => {
      await expect(encerrarInstancia(undefined)).resolves.toBeUndefined();
    });

    it("encerramento seguro: fecha um contexto mesmo quando a limpeza falha", async () => {
      const temporaria = await criarInstancia();
      let fechado = false;
      const espiao = spyOn(temporaria.moduleRef, "close").mockImplementation(async () => {
        fechado = true;
      });
      try {
        await expect(
          encerrarInstancia(temporaria, async () => {
            throw new Error("[INJETADO] falha na limpeza");
          }),
        ).rejects.toThrow("[INJETADO] falha na limpeza");
        expect(fechado).toBe(true);
      } finally {
        espiao.mockRestore();
        await temporaria.moduleRef.close();
      }
    }, 30_000);
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
    await fecharCaixa(inst, cenario.caixa.id);
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
      const { cancelada, venda, produtoId } = await cancelarComFalhaDeRestauracao(p());

      expect(cancelada.status).toBe("cancelada");
      const resumo = resumoSerializado(cancelada);
      expect(resumo.status).toBe("pendente");
      expect(resumo).toMatchObject({ totalItens: 1, concluidos: 0, emFalhaRecuperavel: 1 });
      expect(resumo.proximaTentativaEm).not.toBeNull();

      const linha = await primeiraLinha(p().conexao, venda.id);
      expect(linha.restaurado).toBe(false);
      expect(linha.estadoRestauracao).toBe("falha_recuperavel");
      expect(linha.tentativas).toBe(1);
      expect(linha.ultimaTentativaEm).toBeInstanceOf(Date);
      expect(linha.proximaTentativaEm!.getTime() - linha.ultimaTentativaEm!.getTime()).toBe(CONFIG_TESTE.esperaBaseMs);
      expect(linha.ultimaFalha?.classe).toBe("ApiException");
      expect(JSON.stringify(linha.ultimaFalha)).not.toContain("    at ");
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(0);
      expect(await saldo(p(), produtoId)).toBe(-100); // nada foi devolvido
    });

    it("cancelamento bem-sucedido grava `concluida`, `restauradoEm`, 1 tentativa e responde `concluida`", async () => {
      const cenario = await prepararVenda(p());
      const cancelada = await p().service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Sucesso", idempotencyKey: `ok-${Date.now()}` }, null);
      await fecharCaixa(p(), cenario.caixa.id);

      expect(resumoSerializado(cancelada).status).toBe("concluida");
      const linha = await primeiraLinha(p().conexao, cenario.venda.id);
      expect(linha).toMatchObject({ restaurado: true, estadoRestauracao: "concluida", tentativas: 1, proximaTentativaEm: null, ultimaFalha: null });
      expect(linha.restauradoEm).toBeInstanceOf(Date);
      expect(await saldo(p(), cenario.produtos[0]!.produtoId)).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Worker: recuperação, backoff, limite, restart, concorrência
  // ---------------------------------------------------------------------------------------------------------------

  describe("reconciliação automática (worker)", () => {
    it("recuperação básica: depois de resolvido o problema e vencida a agenda, um ciclo devolve o estoque UMA vez, sem novo evento/caixa", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(p());
      const movimentosCaixaAntes = await p().conexao.collection("movimentos_caixa").countDocuments({ vendaId: venda.id });
      const eventosAntes = await p().conexao.collection("eventos_venda").countDocuments({ vendaId: venda.id });

      await consertarProduto(p().conexao, produtoId);
      await venceAgenda(p().conexao, venda.id);
      const ciclo = await p().worker.executarCiclo();

      expect(ciclo).toMatchObject({ concluidas: 1, falhas: 0 });
      expect(await saldo(p(), produtoId)).toBe(2);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
      expect(await primeiraLinha(p().conexao, venda.id)).toMatchObject({ restaurado: true, estadoRestauracao: "concluida", tentativas: 2, ultimaFalha: null });
      expect(await p().conexao.collection("movimentos_caixa").countDocuments({ vendaId: venda.id })).toBe(movimentosCaixaAntes);
      expect(await p().conexao.collection("eventos_venda").countDocuments({ vendaId: venda.id })).toBe(eventosAntes);
      expect((await vendaBruta(p().conexao, venda.id)).cancelamentos).toHaveLength(1);

      // Ciclo seguinte: nada mais a fazer.
      expect(await p().worker.executarCiclo()).toMatchObject({ tentadas: 0 });
      expect(await saldo(p(), produtoId)).toBe(2);
    });

    it("respeita o backoff: ciclos repetidos antes da agenda não tentam (sem laço agressivo) e a espera dobra a cada falha", async () => {
      const { venda } = await cancelarComFalhaDeRestauracao(p());

      for (let i = 0; i < 5; i += 1) {
        expect(await p().worker.executarCiclo()).toMatchObject({ tentadas: 0 });
      }
      expect((await primeiraLinha(p().conexao, venda.id)).tentativas).toBe(1);

      await venceAgenda(p().conexao, venda.id);
      expect(await p().worker.executarCiclo()).toMatchObject({ tentadas: 1, falhas: 1 });
      const linha = await primeiraLinha(p().conexao, venda.id);
      expect(linha.tentativas).toBe(2);
      expect(linha.estadoRestauracao).toBe("falha_recuperavel");
      expect(linha.proximaTentativaEm!.getTime() - linha.ultimaTentativaEm!.getTime()).toBe(CONFIG_TESTE.esperaBaseMs * 2);
    });

    it("falha persistente: ao atingir o limite vira `requer_intervencao`, o worker para de tentar e a API sinaliza; o operador conclui depois", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(p());

      for (let tentativa = 2; tentativa <= CONFIG_TESTE.maxTentativas; tentativa += 1) {
        await venceAgenda(p().conexao, venda.id);
        await p().worker.executarCiclo();
      }
      let linha = await primeiraLinha(p().conexao, venda.id);
      expect(linha.tentativas).toBe(CONFIG_TESTE.maxTentativas);
      expect(linha.estadoRestauracao).toBe("requer_intervencao");
      expect(linha.proximaTentativaEm).toBeNull();

      // Mesmo com a agenda "vencida", o worker não toca uma linha que requer intervenção.
      await venceAgenda(p().conexao, venda.id);
      expect(await p().worker.executarCiclo()).toMatchObject({ tentadas: 0 });
      expect((await primeiraLinha(p().conexao, venda.id)).tentativas).toBe(CONFIG_TESTE.maxTentativas);

      const detalhe = await p().service.obterPorId(venda.id);
      expect(resumoSerializado(detalhe).status).toBe("requer_intervencao");
      const pendencias = await p().service.listarPendenciasDeRestauracao(100);
      const pendencia = pendencias.itens.find((item) => item.vendaId === venda.id);
      expect(pendencia).toMatchObject({ estado: "requer_intervencao", tentativas: CONFIG_TESTE.maxTentativas, quantidade: 2 });
      expect(pendencia?.ultimaFalha?.classe).toBe("ApiException");

      // Operador: resolve a causa e solicita a reconciliação (sem repetir o cancelamento, sem chave nova).
      await consertarProduto(p().conexao, produtoId);
      const reconciliada = await p().service.reconciliarRestauracaoEstoque(venda.id, null);
      expect(resumoSerializado(reconciliada).status).toBe("concluida");
      linha = await primeiraLinha(p().conexao, venda.id);
      expect(linha).toMatchObject({ restaurado: true, estadoRestauracao: "concluida" });
      expect(await saldo(p(), produtoId)).toBe(2);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
      expect((await p().service.listarPendenciasDeRestauracao(100)).itens.some((item) => item.vendaId === venda.id)).toBe(false);
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
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(p());
      const outra = await criarInstancia();
      extras.push(outra);
      await consertarProduto(p().conexao, produtoId);
      await venceAgenda(p().conexao, venda.id);

      await Promise.allSettled([
        p().worker.executarCiclo(),
        outra.worker.executarCiclo(),
        p().service.reconciliarRestauracaoEstoque(venda.id, null),
        outra.service.reconciliarRestauracaoEstoque(venda.id, null),
        outra.worker.executarCiclo(),
      ]);

      expect(await saldo(p(), produtoId)).toBe(2); // nunca 4 ou mais
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
      const linha = await primeiraLinha(p().conexao, venda.id);
      expect(linha.restaurado).toBe(true);
      expect(linha.tentativas).toBe(2); // 1 falha original + 1 sucesso — nenhuma contagem duplicada
    }, 30_000);

    it("o mesmo worker nunca roda dois ciclos sobrepostos na mesma instância", async () => {
      const primeiro = p().worker.executarCiclo();
      const segundo = p().worker.executarCiclo();
      expect(segundo).toBe(primeiro);
      await primeiro;
    });

    it("habilitado, o worker é iniciado no bootstrap da aplicação, conclui uma pendência sozinho pelo temporizador e para no shutdown", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(p());
      await consertarProduto(p().conexao, produtoId);
      await venceAgenda(p().conexao, venda.id);

      const comWorker = await criarInstancia({ ...CONFIG_TESTE, habilitada: true, intervaloMs: 100 });
      await comWorker.moduleRef.init(); // dispara `onApplicationBootstrap`, como a aplicação real
      expect(comWorker.worker.ativo).toBe(true);
      const limite = Date.now() + 10_000;
      while (Date.now() < limite && (await primeiraLinha(p().conexao, venda.id)).restaurado !== true) {
        await new Promise((resolver) => setTimeout(resolver, 100));
      }
      await comWorker.moduleRef.close();
      expect(comWorker.worker.ativo).toBe(false);
      expect(await saldo(p(), produtoId)).toBe(2);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
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
      const cenario = await prepararVenda(p());
      const produtoId = cenario.produtos[0]!.produtoId;
      espioes.push(
        spyOn(p().ledgerModel, "create").mockImplementationOnce(async () => {
          throw new Error("[INJETADO] falha ao gravar o ledger");
        }),
      );
      const cancelada = await p().service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Ledger", idempotencyKey: `ledger-${Date.now()}` }, null);
      await fecharCaixa(p(), cenario.caixa.id);

      expect(resumoSerializado(cancelada).status).toBe("pendente");
      expect(await saldo(p(), produtoId)).toBe(3); // a devolução da transação abortada não ficou
      expect(await entradasNoLedger(p().conexao, cenario.venda.id)).toBe(0);
      expect(await primeiraLinha(p().conexao, cenario.venda.id)).toMatchObject({ restaurado: false, estadoRestauracao: "falha_recuperavel", tentativas: 1 });

      await p().service.reconciliarRestauracaoEstoque(cenario.venda.id, null);
      expect(await saldo(p(), produtoId)).toBe(5);
      expect(await entradasNoLedger(p().conexao, cenario.venda.id)).toBe(1);
    });

    it("falha ao MARCAR a linha: estoque e ledger da tentativa são desfeitos; a nova tentativa devolve uma única vez", async () => {
      const cenario = await prepararVenda(p());
      const produtoId = cenario.produtos[0]!.produtoId;
      espioes.push(
        spyOn(p().repositorio, "marcarItemRestaurado").mockImplementationOnce(async () => {
          throw new Error("[INJETADO] falha ao marcar a linha");
        }),
      );
      await p().service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Marcar", idempotencyKey: `marcar-${Date.now()}` }, null);
      await fecharCaixa(p(), cenario.caixa.id);

      expect(await saldo(p(), produtoId)).toBe(3);
      expect(await entradasNoLedger(p().conexao, cenario.venda.id)).toBe(0);
      expect((await primeiraLinha(p().conexao, cenario.venda.id)).estadoRestauracao).toBe("falha_recuperavel");

      await venceAgenda(p().conexao, cenario.venda.id);
      await p().worker.executarCiclo();
      expect(await saldo(p(), produtoId)).toBe(5);
      expect(await entradasNoLedger(p().conexao, cenario.venda.id)).toBe(1);
    });

    it("erro TRANSITÓRIO (WriteConflict / TransientTransactionError): a transação inteira é repetida na mesma chamada e conclui sem registrar falha", async () => {
      const cenario = await prepararVenda(p());
      const produtoId = cenario.produtos[0]!.produtoId;
      espioes.push(
        spyOn(p().repositorio, "marcarItemRestaurado").mockImplementationOnce(async () => {
          throw erroTransitorio();
        }),
      );
      const cancelada = await p().service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Transitório", idempotencyKey: `transitorio-${Date.now()}` }, null);
      await fecharCaixa(p(), cenario.caixa.id);

      expect(resumoSerializado(cancelada).status).toBe("concluida");
      expect(await saldo(p(), produtoId)).toBe(5); // nunca 7: a 1ª tentativa (abortada) não deixou devolução
      expect(await entradasNoLedger(p().conexao, cenario.venda.id)).toBe(1);
      expect(await primeiraLinha(p().conexao, cenario.venda.id)).toMatchObject({ estadoRestauracao: "concluida", tentativas: 1, ultimaFalha: null });
    });

    it("commit AMBÍGUO (aplicado no servidor, cliente recebe UnknownTransactionCommitResult até esgotar): nenhuma devolução dupla e nenhuma falha falsa registrada", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(p());
      await consertarProduto(p().conexao, produtoId);

      const commitOriginal = mongo.ClientSession.prototype.commitTransaction;
      espioes.push(
        spyOn(mongo.ClientSession.prototype, "commitTransaction").mockImplementation(async function (this: mongo.ClientSession) {
          await commitOriginal.call(this);
          throw erroCommitAmbiguo();
        }),
      );
      await p().service.reconciliarRestauracaoEstoque(venda.id, null);
      espioes.pop()?.mockRestore();

      expect(await saldo(p(), produtoId)).toBe(2); // aplicado UMA vez
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
      const linha = await primeiraLinha(p().conexao, venda.id);
      expect(linha).toMatchObject({ restaurado: true, estadoRestauracao: "concluida", tentativas: 2 }); // CAS da falha não casou

      // Uma nova reconciliação lê o estado real e não devolve de novo.
      await p().service.reconciliarRestauracaoEstoque(venda.id, null);
      expect(await saldo(p(), produtoId)).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Compatibilidade com dados legados e eventos parcialmente restaurados
  // ---------------------------------------------------------------------------------------------------------------

  describe("compatibilidade com eventos legados (sem migração)", () => {
    /**
     * Cancela normalmente e então reescreve a linha no formato pedido, desfazendo (quando a linha não é `true`) a
     * devolução de estoque e o ledger — o estado físico de uma restauração "nunca feita".
     *   - `true`: legado concluído (só o booleano);
     *   - `false` / `ausente`: legado sem estado explícito (indeterminado — Fase 60.4.3.4.18.3);
     *   - `invalido`: `restaurado:false` com `estadoRestauracao` fora do enum (indeterminado);
     *   - `pendente`: estado explícito gravado pelo código atual (provadamente pendente).
     */
    async function linhaLegada(formato: "true" | "false" | "ausente" | "invalido" | "pendente") {
      const cenario = await prepararVenda(p());
      const produtoId = cenario.produtos[0]!.produtoId;
      const chave = `legado-${formato}-${Date.now()}`;
      await p().service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Legado", idempotencyKey: chave }, null);
      await fecharCaixa(p(), cenario.caixa.id);
      const camposNovos = { estadoRestauracao: "", tentativas: "", ultimaTentativaEm: "", proximaTentativaEm: "", restauradoEm: "", ultimaFalha: "" };
      const unset = Object.fromEntries(Object.keys(camposNovos).map((campo) => [`cancelamentos.$[].itens.$[].${campo}`, ""]));
      const filtro = { _id: new Types.ObjectId(cenario.venda.id) };
      if (formato === "true") {
        await p().conexao.collection("vendas").updateOne(filtro, { $unset: unset });
      } else {
        // Simula restauração nunca feita: desfaz estoque e ledger.
        await p().conexao.collection("produtos").updateOne({ _id: new Types.ObjectId(produtoId) }, { $inc: { "variantes.0.tamanhos.0.quantidade": -2 } });
        await p().conexao.collection("movimentacoes_estoque").deleteMany({ vendaId: cenario.venda.id, origem: "cancelamento" });
        if (formato === "false") {
          await p().conexao.collection("vendas").updateOne(filtro, { $unset: unset, $set: { "cancelamentos.$[].itens.$[].restaurado": false } });
        } else if (formato === "ausente") {
          await p().conexao.collection("vendas").updateOne(filtro, { $unset: { ...unset, "cancelamentos.$[].itens.$[].restaurado": "" } });
        } else {
          await p().conexao.collection("vendas").updateOne(filtro, {
            $set: {
              "cancelamentos.$[].itens.$[].restaurado": false,
              "cancelamentos.$[].itens.$[].estadoRestauracao": formato === "invalido" ? "estado_desconhecido" : "pendente",
              "cancelamentos.$[].itens.$[].tentativas": 0,
            },
          });
        }
      }
      return { ...cenario, produtoId, chave };
    }

    /**
     * Fase 60.4.3.4.18.3 — prova que NENHUM caminho toca uma linha indeterminada: worker, repetição do cancelamento com a
     * MESMA chave e rota ADMIN de reconciliação. Estoque, ledger e a própria linha ficam exatamente como estavam.
     */
    async function exigirIndeterminadaIntacta(vendaId: string, produtoId: string, chave: string): Promise<void> {
      const linhaAntes = await primeiraLinha(p().conexao, vendaId);
      const saldoAntes = await saldo(p(), produtoId);
      expect(saldoAntes).toBe(3); // a devolução nunca foi feita

      // 1. Worker.
      expect(await p().worker.executarCiclo()).toMatchObject({ tentadas: 0, concluidas: 0 });
      // 2. Repetição do cancelamento com a MESMA chave (replay → reconciliarCancelamento).
      const caixa = await p().caixas.abrir({ valorInicial: 1000, observacao: "" }, null);
      try {
        const repetida = await p().service.cancelar(vendaId, { tipo: "integral", motivo: "Repetição", idempotencyKey: chave }, null);
        expect(resumoSerializado(repetida).status).toBe("indeterminado");
      } finally {
        await fecharCaixa(p(), caixa.id);
      }
      // 3. Reconciliação solicitada pelo operador.
      const reconciliada = await p().service.reconciliarRestauracaoEstoque(vendaId, null);
      expect(resumoSerializado(reconciliada)).toMatchObject({ status: "indeterminado", indeterminados: 1, concluidos: 0 });

      expect(await saldo(p(), produtoId)).toBe(saldoAntes); // nenhuma devolução
      expect(await entradasNoLedger(p().conexao, vendaId)).toBe(0); // nenhuma entrada no ledger
      const linhaDepois = await primeiraLinha(p().conexao, vendaId);
      expect(linhaDepois).toEqual(linhaAntes); // nada gravado na linha (nem estado, nem tentativa, nem conclusão)
      expect(linhaDepois.restaurado).not.toBe(true);

      const pendencia = (await p().service.listarPendenciasDeRestauracao(100)).itens.find((item) => item.vendaId === vendaId);
      expect(pendencia?.estado).toBe("indeterminado"); // identificável para análise futura
    }

    it("`restaurado: true` sem os campos novos: lido como concluído; o worker não devolve de novo", async () => {
      const { venda, produtoId } = await linhaLegada("true");
      const linha = await primeiraLinha(p().conexao, venda.id);
      expect(linha.estadoRestauracao).toBeUndefined();
      expect(resumoSerializado(await p().service.obterPorId(venda.id)).status).toBe("concluida");
      await p().worker.executarCiclo();
      expect(await saldo(p(), produtoId)).toBe(5);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
    });

    // Fase 60.4.3.4.18.3 — os dois testes abaixo SUBSTITUEM os de `78194a7` que esperavam devolução automática de
    // `restaurado:false`/ausente sem estado explícito: a regra mudou (indeterminado, nunca devolvido automaticamente).
    it("`restaurado: false` SEM estado explícito: INDETERMINADO — worker, repetição e reconciliação manual não devolvem nada", async () => {
      const { venda, produtoId, chave } = await linhaLegada("false");
      expect(resumoSerializado(await p().service.obterPorId(venda.id)).status).toBe("indeterminado");
      await exigirIndeterminadaIntacta(venda.id, produtoId, chave);
    });

    it("`restaurado` AUSENTE e sem estado explícito: INDETERMINADO — nunca concluído, nunca devolvido", async () => {
      const { venda, produtoId, chave } = await linhaLegada("ausente");
      expect((await primeiraLinha(p().conexao, venda.id)).restaurado).toBeUndefined();
      expect(resumoSerializado(await p().service.obterPorId(venda.id)).status).toBe("indeterminado");
      await exigirIndeterminadaIntacta(venda.id, produtoId, chave);
    });

    it("estado explícito INVÁLIDO: indeterminado, nenhum caminho o processa", async () => {
      const { venda, produtoId, chave } = await linhaLegada("invalido");
      expect(resumoSerializado(await p().service.obterPorId(venda.id)).status).toBe("indeterminado");
      await exigirIndeterminadaIntacta(venda.id, produtoId, chave);
    });

    it("estado explícito `pendente` (código atual): provadamente pendente — o worker devolve UMA vez e conclui", async () => {
      const { venda, produtoId } = await linhaLegada("pendente");
      expect(resumoSerializado(await p().service.obterPorId(venda.id)).status).toBe("pendente");
      expect(await p().worker.executarCiclo()).toMatchObject({ tentadas: 1, concluidas: 1 });
      expect(await saldo(p(), produtoId)).toBe(5);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
      expect(await primeiraLinha(p().conexao, venda.id)).toMatchObject({ restaurado: true, estadoRestauracao: "concluida", tentativas: 1 });
    });

    it("evento PARCIALMENTE restaurado: só a linha pendente é devolvida; a concluída não é tocada", async () => {
      const cenario = await prepararVenda(p(), [2, 1]);
      const [produtoA, produtoB] = cenario.produtos;
      await p().service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Parcial", idempotencyKey: `parcial-${Date.now()}` }, null);
      await fecharCaixa(p(), cenario.caixa.id);
      // Desfaz SÓ a linha B (como se tivesse falhado).
      await p().conexao.collection("produtos").updateOne({ _id: new Types.ObjectId(produtoB!.produtoId) }, { $inc: { "variantes.0.tamanhos.0.quantidade": -1 } });
      await p().conexao.collection("movimentacoes_estoque").deleteMany({ vendaId: cenario.venda.id, produtoId: new Types.ObjectId(produtoB!.produtoId) });
      await p().conexao
        .collection("vendas")
        .updateOne(
          { _id: new Types.ObjectId(cenario.venda.id) },
          { $set: { "cancelamentos.0.itens.1.restaurado": false, "cancelamentos.0.itens.1.estadoRestauracao": "pendente" } },
        );
      expect(resumoSerializado(await p().service.obterPorId(cenario.venda.id))).toMatchObject({ status: "pendente", concluidos: 1, pendentes: 1 });

      expect(await p().worker.executarCiclo()).toMatchObject({ tentadas: 1, concluidas: 1 });
      expect(await saldo(p(), produtoA!.produtoId)).toBe(5);
      expect(await saldo(p(), produtoB!.produtoId)).toBe(5);
      expect(await entradasNoLedger(p().conexao, cenario.venda.id, produtoA!.produtoId)).toBe(1);
      expect(await entradasNoLedger(p().conexao, cenario.venda.id, produtoB!.produtoId)).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Referências ausentes (Fase 60.4.3.4.18.3)
  // ---------------------------------------------------------------------------------------------------------------

  describe("referências de estoque ausentes: requer_intervencao com código específico, nunca concluída sem devolução", () => {
    interface ProdutoBruto {
      excluidoEm?: Date | null;
      variantes: { _id: Types.ObjectId; tamanhos: { _id: Types.ObjectId; tamanho: string; quantidade: number }[] }[];
    }

    async function produtoBruto(produtoId: string): Promise<ProdutoBruto> {
      const doc = await p().conexao.collection<ProdutoBruto>("produtos").findOne({ _id: new Types.ObjectId(produtoId) });
      if (!doc) throw new Error(`produto ${produtoId} não encontrado`);
      return doc;
    }

    /**
     * Linha PROVADAMENTE pendente (falha real registrada pelo código atual), com a causa original já resolvida
     * (saldo 0); `quebrarReferencia` então remove uma referência. A reconciliação do operador é tentada.
     */
    async function reconciliarComReferenciaAusente(quebrarReferencia: (cenario: Awaited<ReturnType<typeof cancelarComFalhaDeRestauracao>>) => Promise<void>) {
      const cenario = await cancelarComFalhaDeRestauracao(p());
      await consertarProduto(p().conexao, cenario.produtoId);
      expect((await primeiraLinha(p().conexao, cenario.venda.id)).estadoRestauracao).toBe("falha_recuperavel");
      await quebrarReferencia(cenario);
      const reconciliada = await p().service.reconciliarRestauracaoEstoque(cenario.venda.id, null);
      const linha = await primeiraLinha(p().conexao, cenario.venda.id);
      return { ...cenario, reconciliada, linha };
    }

    function exigirIntervencao(linha: LinhaBruta, codigo: string): void {
      expect(linha.restaurado).toBe(false); // nunca marcada como concluída
      expect(linha.estadoRestauracao).toBe("requer_intervencao"); // direto, sem esperar o limite de tentativas
      expect(linha.tentativas).toBe(2);
      expect(linha.proximaTentativaEm).toBeNull();
      expect(linha.ultimaFalha).toMatchObject({ classe: "ReferenciaDeEstoqueAusenteErro", codigo });
    }

    it("item da venda inexistente → ITEM_VENDA_INEXISTENTE; nenhum estoque, nenhum ledger", async () => {
      const { venda, produtoId, reconciliada, linha } = await reconciliarComReferenciaAusente(async ({ venda }) => {
        await p().conexao
          .collection("vendas")
          .updateOne({ _id: new Types.ObjectId(venda.id) }, { $set: { "cancelamentos.0.itens.0.itemId": new Types.ObjectId().toHexString() } });
      });
      exigirIntervencao(linha, "ITEM_VENDA_INEXISTENTE");
      expect(resumoSerializado(reconciliada).status).toBe("requer_intervencao");
      expect(await saldo(p(), produtoId)).toBe(0);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(0);
    });

    it("item sem variante → ITEM_SEM_VARIANTE; nenhum estoque, nenhum ledger", async () => {
      const { venda, produtoId, linha } = await reconciliarComReferenciaAusente(async ({ venda }) => {
        await p().conexao.collection("vendas").updateOne({ _id: new Types.ObjectId(venda.id) }, { $set: { "itens.0.varianteId": null } });
      });
      exigirIntervencao(linha, "ITEM_SEM_VARIANTE");
      expect(await saldo(p(), produtoId)).toBe(0);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(0);
    });

    it("produto excluído → PRODUTO_EXCLUIDO_OU_INEXISTENTE; o saldo do produto excluído não muda", async () => {
      const { venda, produtoId, linha } = await reconciliarComReferenciaAusente(async ({ produtoId }) => {
        await p().produtos.excluir(produtoId, null);
      });
      exigirIntervencao(linha, "PRODUTO_EXCLUIDO_OU_INEXISTENTE");
      const bruto = await produtoBruto(produtoId);
      expect(bruto.excluidoEm).toBeInstanceOf(Date);
      expect(bruto.variantes[0]!.tamanhos[0]!.quantidade).toBe(0);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(0);
    });

    it("variante removida → VARIANTE_INEXISTENTE; nenhum ledger", async () => {
      const { venda, produtoId, linha } = await reconciliarComReferenciaAusente(async ({ produtoId, produtos }) => {
        await p().produtos.removerVariante(produtoId, produtos[0]!.varianteId, null);
      });
      exigirIntervencao(linha, "VARIANTE_INEXISTENTE");
      expect((await produtoBruto(produtoId)).variantes).toHaveLength(0);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(0);
    });

    it("tamanho removido → TAMANHO_INEXISTENTE; o tamanho NÃO é recriado silenciosamente", async () => {
      const { venda, produtoId, linha } = await reconciliarComReferenciaAusente(async ({ produtoId, produtos }) => {
        await p().produtos.removerTamanho(produtoId, produtos[0]!.varianteId, produtos[0]!.tamanhoId, null);
      });
      exigirIntervencao(linha, "TAMANHO_INEXISTENTE");
      expect((await produtoBruto(produtoId)).variantes[0]!.tamanhos).toHaveLength(0);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(0);
    });

    it("o worker não repete uma linha em intervenção por referência ausente", async () => {
      const { venda, linha } = await reconciliarComReferenciaAusente(async ({ produtoId, produtos }) => {
        await p().produtos.removerVariante(produtoId, produtos[0]!.varianteId, null);
      });
      exigirIntervencao(linha, "VARIANTE_INEXISTENTE");
      await venceAgenda(p().conexao, venda.id); // mesmo com agenda "vencida"
      const antesDoCiclo = await primeiraLinha(p().conexao, venda.id);
      expect(await p().worker.executarCiclo()).toMatchObject({ tentadas: 0 });
      expect(await primeiraLinha(p().conexao, venda.id)).toEqual(antesDoCiclo);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Repetição do cancelamento (Backoffice)
  // ---------------------------------------------------------------------------------------------------------------

  describe("repetição do cancelamento", () => {
    it("MESMA chave com restauração pendente: conclui o estoque sem novo evento, sem novo movimento de caixa e sem nova reversão de agregados", async () => {
      const { venda, produtoId, chave } = await cancelarComFalhaDeRestauracao(p());
      const vendedorAntes = await p().conexao.collection("vendedores").findOne({ _id: new Types.ObjectId(venda.vendedorId) });
      const movimentosAntes = await p().conexao.collection("movimentos_caixa").countDocuments({ vendaId: venda.id });
      const eventosAntes = await p().conexao.collection("eventos_venda").countDocuments({ vendaId: venda.id });
      await consertarProduto(p().conexao, produtoId);

      const caixa = await p().caixas.abrir({ valorInicial: 1000, observacao: "" }, null); // replay exige caixa aberto
      const repetida = await p().service.cancelar(venda.id, { tipo: "integral", motivo: "Repetição", idempotencyKey: chave }, null);
      await fecharCaixa(p(), caixa.id);

      expect(resumoSerializado(repetida).status).toBe("concluida");
      expect(await saldo(p(), produtoId)).toBe(2);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
      expect((await vendaBruta(p().conexao, venda.id)).cancelamentos).toHaveLength(1);
      expect(await p().conexao.collection("movimentos_caixa").countDocuments({ vendaId: venda.id })).toBe(movimentosAntes);
      expect(await p().conexao.collection("eventos_venda").countDocuments({ vendaId: venda.id })).toBe(eventosAntes);
      expect(await p().conexao.collection("vendedores").findOne({ _id: new Types.ObjectId(venda.vendedorId) })).toEqual(vendedorAntes);
    });

    it("chave DIFERENTE numa venda já cancelada: rejeitada como antes, sem nenhuma alteração", async () => {
      const { venda, produtoId } = await cancelarComFalhaDeRestauracao(p());
      const antes = await vendaBruta(p().conexao, venda.id);
      const caixa = await p().caixas.abrir({ valorInicial: 1000, observacao: "" }, null);
      try {
        await expect(p().service.cancelar(venda.id, { tipo: "integral", motivo: "Outra chave", idempotencyKey: `outra-${Date.now()}` }, null)).rejects.toThrow(
          "Esta venda já está cancelada.",
        );
      } finally {
        await fecharCaixa(p(), caixa.id);
      }
      expect(await vendaBruta(p().conexao, venda.id)).toEqual(antes);
      expect(await saldo(p(), produtoId)).toBe(-100);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Fase 60.4.3.4.19.5 — observabilidade dos ciclos (contadores e eventos com MongoDB real)
  // ---------------------------------------------------------------------------------------------------------------

  describe("observabilidade dos ciclos (Fase 60.4.3.4.19.5)", () => {
    interface Registro {
      nivel: "log" | "warn" | "error";
      dados: Record<string, unknown>;
    }

    /** Captura os eventos JSON do logger de um objeto (worker ou service) sem silenciar a contagem real. */
    function capturarLogs(alvo: object): Registro[] {
      const logger = (alvo as { logger: Logger }).logger;
      const registros: Registro[] = [];
      for (const nivel of ["log", "warn", "error"] as const) {
        espioes.push(
          spyOn(logger, nivel).mockImplementation((mensagem: unknown) => {
            registros.push({ nivel, dados: JSON.parse(String(mensagem)) as Record<string, unknown> });
          }),
        );
      }
      return registros;
    }

    const doEvento = (registros: Registro[], evento: string) => registros.filter((registro) => registro.dados["evento"] === evento);

    /** Cada linha tentada tem exatamente UM desfecho; `falhas` é a soma dos três desfechos de falha. */
    function exigirIdentidade(ciclo: ResultadoCicloReconciliacao | null): ResultadoCicloReconciliacao {
      expect(ciclo).not.toBeNull();
      const c = ciclo!;
      expect(c.tentadas).toBe(
        c.concluidas + c.jaConcluidas + c.falhasRecuperaveis + c.requeremIntervencao + c.falhasNaoRegistradas + c.adiadasNaTransacao + c.indeterminadasNaTransacao,
      );
      expect(c.falhas).toBe(c.falhasRecuperaveis + c.requeremIntervencao + c.falhasNaoRegistradas);
      expect(c.vendas).toBeLessThanOrEqual(c.vendasConsultadas);
      return c;
    }

    /** Linha pendente com a causa resolvida e a agenda vencida — pronta para o próximo ciclo concluir. */
    async function pendenciaPronta(inst: Instancia) {
      const cenario = await cancelarComFalhaDeRestauracao(inst);
      await consertarProduto(inst.conexao, cenario.produtoId);
      await venceAgenda(inst.conexao, cenario.venda.id);
      return cenario;
    }

    it("8. uma linha concluída: contadores exatos e `ciclo_concluido` com resultado `processado`", async () => {
      const { venda, produtoId } = await pendenciaPronta(p());
      const logs = capturarLogs(p().worker);

      const ciclo = exigirIdentidade(await p().worker.executarCiclo());
      expect(ciclo).toMatchObject({ vendasConsultadas: 1, vendas: 1, tentadas: 1, concluidas: 1, jaConcluidas: 0, falhas: 0, adiadas: 0, indeterminadas: 0, vendasComErro: 0 });
      expect(await saldo(p(), produtoId)).toBe(2);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);

      const [concluido] = doEvento(logs, "reconciliacao_estoque.ciclo_concluido");
      expect(concluido!.nivel).toBe("log");
      expect(concluido!.dados).toMatchObject({ resultado: "processado", vendasConsultadas: 1, vendasProcessadas: 1, itensElegiveis: 1, itensConcluidos: 1, falhasRecuperaveis: 0 });
      expect(doEvento(logs, "reconciliacao_estoque.ciclo_iniciado")[0]!.dados["cicloId"]).toBe(concluido!.dados["cicloId"]);

      // Ciclo seguinte: vazio, mas COMPROVADO por `ciclo_concluido`.
      exigirIdentidade(await p().worker.executarCiclo());
      expect(doEvento(logs, "reconciliacao_estoque.ciclo_concluido")[1]!.dados).toMatchObject({ resultado: "sem_itens_elegiveis", vendasConsultadas: 0, itensElegiveis: 0 });
    });

    it("9. várias linhas em vendas diferentes: somadas; com `maxItensPorCiclo` atingido, `vendasProcessadas < vendasConsultadas`", async () => {
      const a = await pendenciaPronta(p());
      const b = await pendenciaPronta(p());

      const limitada = await criarInstancia({ ...CONFIG_TESTE, maxItensPorCiclo: 1 });
      extras.push(limitada);
      const primeiro = exigirIdentidade(await limitada.worker.executarCiclo());
      expect(primeiro).toMatchObject({ vendasConsultadas: 2, vendas: 1, tentadas: 1, concluidas: 1 });

      const segundo = exigirIdentidade(await p().worker.executarCiclo());
      expect(segundo).toMatchObject({ vendasConsultadas: 1, vendas: 1, tentadas: 1, concluidas: 1 });
      expect(await saldo(p(), a.produtoId)).toBe(2);
      expect(await saldo(p(), b.produtoId)).toBe(2);

      // Sem limite: duas vendas pendentes no MESMO ciclo.
      const c = await pendenciaPronta(p());
      const d = await pendenciaPronta(p());
      expect(exigirIdentidade(await p().worker.executarCiclo())).toMatchObject({ vendasConsultadas: 2, vendas: 2, tentadas: 2, concluidas: 2 });
      expect(await entradasNoLedger(p().conexao, c.venda.id)).toBe(1);
      expect(await entradasNoLedger(p().conexao, d.venda.id)).toBe(1);
    }, 30_000);

    it("10. falha RECUPERÁVEL: `falhasRecuperaveis` (não intervenção), `ciclo_concluido` em WARN com `processado_com_falhas`", async () => {
      const { venda } = await cancelarComFalhaDeRestauracao(p()); // produto continua quebrado
      await venceAgenda(p().conexao, venda.id);
      const logs = capturarLogs(p().worker);

      const ciclo = exigirIdentidade(await p().worker.executarCiclo());
      expect(ciclo).toMatchObject({ tentadas: 1, falhas: 1, falhasRecuperaveis: 1, requeremIntervencao: 0, falhasNaoRegistradas: 0, concluidas: 0 });
      expect((await primeiraLinha(p().conexao, venda.id)).estadoRestauracao).toBe("falha_recuperavel");
      const [concluido] = doEvento(logs, "reconciliacao_estoque.ciclo_concluido");
      expect(concluido!.nivel).toBe("warn");
      expect(concluido!.dados).toMatchObject({ resultado: "processado_com_falhas", falhasRecuperaveis: 1, requeremIntervencao: 0 });
      expect(doEvento(logs, "reconciliacao_estoque.ciclo_falhou")).toHaveLength(0); // falha de LINHA ≠ falha do ciclo
    });

    it("11a. referência AUSENTE pelo worker: `requeremIntervencao` (não recuperável); o ciclo seguinte não a consulta", async () => {
      const { venda, produtoId, produtos } = await pendenciaPronta(p());
      await p().produtos.removerVariante(produtoId, produtos[0]!.varianteId, null);

      const ciclo = exigirIdentidade(await p().worker.executarCiclo());
      expect(ciclo).toMatchObject({ tentadas: 1, requeremIntervencao: 1, falhasRecuperaveis: 0, falhasNaoRegistradas: 0 });
      expect((await primeiraLinha(p().conexao, venda.id)).estadoRestauracao).toBe("requer_intervencao");

      await venceAgenda(p().conexao, venda.id);
      expect(exigirIdentidade(await p().worker.executarCiclo())).toMatchObject({ vendasConsultadas: 0, tentadas: 0, requeremIntervencao: 0 });
    });

    it("11b. tentativas ESGOTADAS: a última falha conta como `requeremIntervencao`, as anteriores como `falhasRecuperaveis`", async () => {
      const { venda } = await cancelarComFalhaDeRestauracao(p()); // tentativa 1 no cancelamento
      const desfechos: Pick<ResultadoCicloReconciliacao, "falhasRecuperaveis" | "requeremIntervencao">[] = [];
      for (let tentativa = 2; tentativa <= CONFIG_TESTE.maxTentativas; tentativa += 1) {
        await venceAgenda(p().conexao, venda.id);
        const { falhasRecuperaveis, requeremIntervencao } = exigirIdentidade(await p().worker.executarCiclo());
        desfechos.push({ falhasRecuperaveis, requeremIntervencao });
      }
      expect(desfechos).toEqual([
        { falhasRecuperaveis: 1, requeremIntervencao: 0 }, // tentativa 2
        { falhasRecuperaveis: 0, requeremIntervencao: 1 }, // tentativa 3 = maxTentativas
      ]);
      expect((await primeiraLinha(p().conexao, venda.id)).estadoRestauracao).toBe("requer_intervencao");
    });

    it("11c. linhas NÃO tentadas da mesma venda: `adiados` (já em intervenção) e `indeterminados` fora de `itensElegiveis`", async () => {
      const cenario = await prepararVenda(p(), [2, 1, 1]);
      await p().service.cancelar(cenario.venda.id, { tipo: "integral", motivo: "Mista", idempotencyKey: `mista-${Date.now()}` }, null);
      await fecharCaixa(p(), cenario.caixa.id);
      const produtoB = cenario.produtos[1]!.produtoId;
      // Linha B volta a ser provadamente pendente (desfaz a devolução dela); A vira `requer_intervencao`; C, indeterminada.
      await p().conexao.collection("produtos").updateOne({ _id: new Types.ObjectId(produtoB) }, { $inc: { "variantes.0.tamanhos.0.quantidade": -1 } });
      await p().conexao.collection("movimentacoes_estoque").deleteMany({ vendaId: cenario.venda.id, produtoId: new Types.ObjectId(produtoB) });
      await p().conexao.collection("vendas").updateOne(
        { _id: new Types.ObjectId(cenario.venda.id) },
        {
          $set: {
            "cancelamentos.0.itens.0.restaurado": false,
            "cancelamentos.0.itens.0.estadoRestauracao": "requer_intervencao",
            "cancelamentos.0.itens.1.restaurado": false,
            "cancelamentos.0.itens.1.estadoRestauracao": "pendente",
            "cancelamentos.0.itens.2.restaurado": false,
          },
          $unset: { "cancelamentos.0.itens.2.estadoRestauracao": "" },
        },
      );
      const logs = capturarLogs(p().worker);

      const ciclo = exigirIdentidade(await p().worker.executarCiclo());
      expect(ciclo).toMatchObject({ vendasConsultadas: 1, tentadas: 1, concluidas: 1, adiadas: 1, adiadasNaTransacao: 0, indeterminadas: 1, indeterminadasNaTransacao: 0 });
      expect(doEvento(logs, "reconciliacao_estoque.ciclo_concluido")[0]!.dados).toMatchObject({
        resultado: "processado",
        itensElegiveis: 1,
        itensConcluidos: 1,
        adiados: 1,
        indeterminados: 1,
        adiadosNaTransacao: 0,
        indeterminadosNaTransacao: 0,
      });
      expect(await saldo(p(), produtoB)).toBe(5);
    });

    it("12. erro isolado em UMA venda: `vendasComErro`, as demais são processadas e o ciclo CONCLUI (não `ciclo_falhou`)", async () => {
      const a = await pendenciaPronta(p());
      const b = await pendenciaPronta(p());
      const original = p().repositorio.encontrarPorIdOuFalhar.bind(p().repositorio);
      espioes.push(
        spyOn(p().repositorio, "encontrarPorIdOuFalhar").mockImplementation(async (...args: Parameters<VendasRepository["encontrarPorIdOuFalhar"]>) => {
          const [vendaId, sessao] = args;
          if (vendaId === a.venda.id && !sessao) throw new Error("[INJETADO] falha de leitura da venda");
          return original(...args);
        }),
      );
      const logsWorker = capturarLogs(p().worker);
      const logsService = capturarLogs(p().service);

      const ciclo = exigirIdentidade(await p().worker.executarCiclo());
      expect(ciclo).toMatchObject({ vendasConsultadas: 2, vendas: 2, vendasComErro: 1, tentadas: 1, concluidas: 1 });
      expect(await saldo(p(), b.produtoId)).toBe(2);
      expect(await saldo(p(), a.produtoId)).toBe(0); // nada foi feito na venda com erro
      expect(doEvento(logsWorker, "reconciliacao_estoque.ciclo_falhou")).toHaveLength(0);
      expect(doEvento(logsWorker, "reconciliacao_estoque.ciclo_concluido")[0]!.dados).toMatchObject({ resultado: "processado_com_falhas", vendasComErro: 1, itensConcluidos: 1 });
      expect(doEvento(logsService, "restauracao_estoque.erro_venda")[0]!.dados).toMatchObject({ vendaId: a.venda.id, erroClasse: "Error" });
    });

    it("13. retry TRANSITÓRIO dentro da transação: uma tentativa lógica, um commit, um ledger — sem contagem duplicada", async () => {
      const { venda, produtoId } = await pendenciaPronta(p());
      let chamadas = 0;
      const original = p().repositorio.marcarItemRestaurado.bind(p().repositorio);
      espioes.push(
        spyOn(p().repositorio, "marcarItemRestaurado").mockImplementation(async (...args: Parameters<VendasRepository["marcarItemRestaurado"]>) => {
          chamadas += 1;
          if (chamadas === 1) throw erroTransitorio();
          return original(...args);
        }),
      );

      const ciclo = exigirIdentidade(await p().worker.executarCiclo());
      expect(chamadas).toBe(2); // a transação foi de fato repetida
      expect(ciclo).toMatchObject({ tentadas: 1, concluidas: 1, jaConcluidas: 0, falhas: 0 });
      expect(await saldo(p(), produtoId)).toBe(2);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
      expect((await primeiraLinha(p().conexao, venda.id)).tentativas).toBe(2); // 1 falha original + 1 sucesso
    });

    it("14. SHUTDOWN durante a transação: `worker_parando` antes, a transação termina íntegra, `worker_parado` depois", async () => {
      const { venda, produtoId } = await pendenciaPronta(p());
      const outra = await criarInstancia();
      const logs = capturarLogs(outra.worker);
      let entrou = false;
      let liberar!: () => void;
      const aberto = new Promise<void>((resolver) => {
        liberar = resolver;
      });
      const createOriginal = outra.ledgerModel.create.bind(outra.ledgerModel) as (...args: unknown[]) => Promise<unknown>;
      espioes.push(
        spyOn(outra.ledgerModel, "create").mockImplementationOnce((async (...args: unknown[]) => {
          entrou = true;
          await aberto; // a transação está aberta: estoque já ajustado na sessão, ledger e marcação pendentes
          return createOriginal(...args);
        }) as never),
      );

      let fechamento: Promise<void> | undefined;
      try {
        const ciclo = outra.worker.executarCiclo();
        const limite = Date.now() + 10_000;
        while (!entrou && Date.now() < limite) await new Promise((resolver) => setTimeout(resolver, 10));
        expect(entrou).toBe(true);

        fechamento = outra.moduleRef.close();
        while (!doEvento(logs, "reconciliacao_estoque.worker_parando").length && Date.now() < limite) await new Promise((resolver) => setTimeout(resolver, 10));
        expect(doEvento(logs, "reconciliacao_estoque.worker_parando")[0]!.dados).toMatchObject({ execucaoId: outra.worker.execucaoId, cicloEmAndamento: true });
        expect(doEvento(logs, "reconciliacao_estoque.worker_parado")).toHaveLength(0);
        expect((await primeiraLinha(p().conexao, venda.id)).restaurado).toBe(false); // nada confirmado ainda

        liberar();
        const resultado = exigirIdentidade(await ciclo);
        expect(resultado).toMatchObject({ tentadas: 1, concluidas: 1 });
      } finally {
        liberar();
        await (fechamento ?? outra.moduleRef.close());
      }

      const ordem = logs.map((registro) => registro.dados["evento"]);
      expect(ordem.indexOf("reconciliacao_estoque.worker_parando")).toBeLessThan(ordem.indexOf("reconciliacao_estoque.ciclo_concluido"));
      expect(ordem.indexOf("reconciliacao_estoque.ciclo_concluido")).toBeLessThan(ordem.indexOf("reconciliacao_estoque.worker_parado"));
      expect(doEvento(logs, "reconciliacao_estoque.worker_parado")[0]!.dados).toMatchObject({ ciclosExecutados: 1 });
      expect(await saldo(p(), produtoId)).toBe(2); // devolução, ledger e marcação confirmados juntos — uma vez
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
      expect(await primeiraLinha(p().conexao, venda.id)).toMatchObject({ restaurado: true, estadoRestauracao: "concluida" });
    }, 30_000);

    it("15. CONCORRÊNCIA entre dois workers: exatamente UM `itensConcluidos` no total; identidade dos contadores em cada um", async () => {
      const { venda, produtoId } = await pendenciaPronta(p());
      const outra = await criarInstancia();
      extras.push(outra);
      expect(outra.worker.execucaoId).not.toBe(p().worker.execucaoId);

      const [c1, c2] = await Promise.all([p().worker.executarCiclo(), outra.worker.executarCiclo()]);
      const a = exigirIdentidade(c1);
      const b = exigirIdentidade(c2);
      expect(a.concluidas + b.concluidas).toBe(1);
      expect(a.falhasRecuperaveis + b.falhasRecuperaveis + a.requeremIntervencao + b.requeremIntervencao).toBe(0);
      expect(await saldo(p(), produtoId)).toBe(2);
      expect(await entradasNoLedger(p().conexao, venda.id)).toBe(1);
      expect((await primeiraLinha(p().conexao, venda.id)).tentativas).toBe(2);
    }, 30_000);
  });
});
