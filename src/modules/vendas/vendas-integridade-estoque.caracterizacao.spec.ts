/**
 * Fase 60.4.3.4.11.1 — TESTES DE CARACTERIZAÇÃO (F04 / E7 / E8) — INTENCIONALMENTE VERMELHOS.
 * Fase 60.4.3.4.11.3 — adaptados para execução E2E no MongoDB Atlas, num banco EXCLUSIVO.
 *
 * Cada teste reproduz um defeito de integridade entre venda e estoque descrito em
 * `auditorias/Fase-60.4.3.4.11-Diagnostico-Integridade-Venda-Estoque.md` e termina com a verificação do comportamento
 * CORRETO (o que a correção da subetapa 11.5/11.6 deve garantir). Enquanto o defeito existir, essa verificação final
 * falha com `[CARACTERIZAÇÃO F04]` e mostra o estado real persistido (a evidência do defeito).
 *
 * BANCO E CONEXÃO
 *   - A URI vem EXCLUSIVAMENTE de `MONGODB_URI_E2E_F04`, definida só no ambiente do processo que executa o teste.
 *     Não há fallback para `MONGODB_URI`, `MONGODB_URI_TESTE` nem nenhuma outra variável ou arquivo.
 *   - O banco no path da URI precisa ser EXATAMENTE `mariela_e2e_f04`. Qualquer outro (inclusive `marielaDB` e
 *     `mariela_test`) é recusado ANTES de abrir qualquer conexão. A URI, as credenciais e a query nunca são impressas;
 *     a URI é usada como veio (parâmetros de conexão e autenticação preservados).
 *
 * LIMPEZA (menor privilégio)
 *   - `dropDatabase` exige a ação `dropDatabase`, que NÃO faz parte do papel `readWrite`. Para que o usuário E2E
 *     precise só de `readWrite` no banco `mariela_e2e_f04`, a limpeza apaga as coleções uma a uma (`listCollections` +
 *     `dropCollection`, ambas incluídas em `readWrite`). Um banco sem coleções deixa de existir no MongoDB.
 *   - Guarda: só limpa quando o nome efetivo da conexão (Mongoose) E do banco do driver são exatamente
 *     `mariela_e2e_f04`. Não existe nenhum caminho de exclusão para outro banco.
 *   - Recuperação de execução interrompida: se o processo morrer no meio (o `finally` não roda), o resíduo — documentos
 *     bloqueadores de T1/T3, a sequência corrompida de T7, um caixa aberto — fica só em `mariela_e2e_f04`, e o
 *     `beforeAll` da próxima execução apaga todas as coleções desse banco antes de começar.
 *
 * CLASSIFICAÇÃO DE FALHAS (nenhuma mensagem contém URI, credencial ou host do Atlas)
 *   - `[SETUP]`             preparação do cenário ou configuração do ambiente (variável ausente/inválida);
 *   - `[INJEÇÃO]`           a falha planejada não ocorreu;
 *   - `[PRÉ-CONDIÇÃO]`      o estado intermediário não é o esperado;
 *   - `[INFRAESTRUTURA]`    autenticação, rede, seleção de servidor ou indisponibilidade do Atlas;
 *   - `[CARACTERIZAÇÃO F04]` SÓ a verificação final do comportamento correto falhou — reprodução do defeito;
 *   - `[NÃO CLASSIFICADA]`  qualquer outro erro inesperado (investigar; nunca conta como reprodução).
 *
 * PRAZOS (só deste arquivo; nenhum prazo global é alterado) — ver as constantes `PRAZO_*` abaixo.
 *
 * Injeção de falhas: por ESTADO REAL do banco sempre que possível (T1, T3, T7). Onde não há como induzir a falha só com
 * estado (T10a, T10b) usa `spyOn` pontual em UMA instância de repositório, restaurado em `finally`. T5 usa dois contextos
 * Nest independentes (duas conexões, duas instâncias de `VendasService`) no MESMO banco E2E, coordenados por barreiras
 * determinísticas — sem `sleep`. Nenhum cenário usa sessões/transações: funcionam em standalone e em replica set.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, MongooseModule } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { createConnection, Types, type Connection } from "mongoose";
import { liberarTudo, novoPonto } from "../../test-utils/barreira.util.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { CaixasService } from "../caixas/caixas.service.js";
import { ConfiguracoesService } from "../configuracoes/configuracoes.service.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import type { CancelamentoDto } from "./dto/cancelamento.dto.js";
import { CHAVE_SEQUENCIA_VENDA, DIGITOS_NUMERO_VENDA } from "./vendas.constants.js";
import { VendasModule } from "./vendas.module.js";
import { VendasRepository } from "./vendas.repository.js";
import { VendasService } from "./vendas.service.js";
import type { DadosCriarVenda } from "./vendas.types.js";

const JWT_MODULO_DE_TESTE = JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });
const PREFIXO = "[CARACTERIZAÇÃO F04 — VERMELHO ESPERADO]";
const PRECO = 100;
const ESTOQUE_INICIAL = 10;
const QUANTIDADE = 2;

/** Única variável lida para a conexão — sem fallback. */
const VARIAVEL_URI_E2E = "MONGODB_URI_E2E_F04";
/** Único banco que este arquivo usa e o ÚNICO que ele pode limpar. */
const BANCO_E2E = "mariela_e2e_f04";

/**
 * PRAZOS — dimensionados para o Atlas (rede pública + TLS), sem alterar nenhum prazo global do projeto:
 *   - seleção de servidor: 15 s por tentativa — falha de rede/acesso aparece como `[INFRAESTRUTURA]` bem antes do prazo
 *     do teste (o padrão do driver é 30 s); o contexto Nest faz no máximo 1 nova tentativa (padrão do módulo: 9 × 3 s);
 *   - `beforeAll` 120 s: conexão de limpeza (até 15 s), `listCollections` + `dropCollection` de ~30 coleções, contexto
 *     Nest (até 2 × 15 s numa falha; ~2–3 s no caso normal), criação de ~30 coleções e dos índices dos schemas
 *     (dezenas de idas e voltas) e 4 itens de configuração;
 *   - cada teste 60 s: ~60–80 idas e voltas (produto, variante, estoque, vendedor com argon2id, caixa, venda,
 *     cancelamento/reconciliação, fechamento) a até ~250 ms cada ≈ 20 s, mais margem de 3×;
 *   - T5 90 s: o mesmo, mais um segundo contexto Nest (nova conexão TLS + inicialização dos modelos);
 *   - `afterAll` 60 s: remoções por id e `dropCollection` de ~30 coleções.
 * Um deadlock nas barreiras do T5 aparece como estouro de prazo em no máximo 90 s — não é mascarado por prazos maiores.
 */
const SELECAO_SERVIDOR_MS = 15_000;
const PRAZO_BEFORE_ALL_MS = 120_000;
const PRAZO_AFTER_ALL_MS = 60_000;
const PRAZO_TESTE_MS = 60_000;
const PRAZO_TESTE_T5_MS = 90_000;
const OPCOES_CONTEXTO_NEST = { serverSelectionTimeoutMS: SELECAO_SERVIDOR_MS, retryAttempts: 1, retryDelay: 1_000 };

/** Erros do driver/servidor que significam rede, acesso ou disponibilidade — nunca reprodução do defeito. */
const NOMES_ERRO_INFRAESTRUTURA = new Set([
  "MongoServerSelectionError",
  "MongooseServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
]);
/** 6 HostUnreachable · 7 HostNotFound · 13 Unauthorized · 18 AuthenticationFailed · 89 NetworkTimeout · 91 ShutdownInProgress · 189 PrimarySteppedDown · 8000 AtlasError. */
const CODIGOS_ERRO_INFRAESTRUTURA = new Set([6, 7, 13, 18, 89, 91, 189, 8000]);
const ROTULOS = /^\[(SETUP|INJEÇÃO|PRÉ-CONDIÇÃO|INFRAESTRUTURA|CARACTERIZAÇÃO F04|NÃO CLASSIFICADA)\]/;

interface TamanhoBruto { _id: Types.ObjectId; quantidade: number }
interface ProdutoBruto { _id: Types.ObjectId; variantes: { tamanhos: TamanhoBruto[] }[] }
interface VendaBruta { _id: Types.ObjectId; codigo: string; numero: string; caixaId?: string; idempotencyKey?: string | null; cancelamentos?: { itens: { restaurado: boolean; restaurando: boolean }[] }[] }
interface SequenciaBruta { _id: string; valor: unknown }
interface VendedorBruto { _id: Types.ObjectId; vendas: number }

type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: unknown };

/**
 * Lê e valida `MONGODB_URI_E2E_F04` ANTES de qualquer conexão. Devolve a URI exatamente como veio. Recusa: variável
 * ausente/vazia, formato não reconhecido e qualquer banco no path diferente de `mariela_e2e_f04`. Nenhuma mensagem
 * inclui a URI ou parte dela.
 */
function lerUriE2E(): string {
  const uri = process.env[VARIAVEL_URI_E2E];
  if (uri === undefined || uri.trim() === "") {
    throw new Error(`[SETUP] defina ${VARIAVEL_URI_E2E} no ambiente DESTE processo; nenhuma outra variável é usada como alternativa.`);
  }
  const partes = /^mongodb(?:\+srv)?:\/\/[^/\s]+\/([^/?\s]+)(?:\?\S*)?$/.exec(uri);
  if (!partes) {
    throw new Error(`[SETUP] ${VARIAVEL_URI_E2E} em formato não reconhecido (esperado mongodb:// ou mongodb+srv://<host>/${BANCO_E2E}[?opções]).`);
  }
  if (partes[1] !== BANCO_E2E) {
    throw new Error(`[SETUP] ${VARIAVEL_URI_E2E} precisa apontar exatamente para o banco "${BANCO_E2E}"; o banco informado foi recusado.`);
  }
  return uri;
}

function codigoMongo(erro: unknown): number | null {
  return erro instanceof Error && "code" in erro && typeof erro.code === "number" ? erro.code : null;
}

/** Remove de qualquer texto de erro URIs e hosts do Atlas antes de exibi-lo. */
function sanitizar(texto: string): string {
  return texto.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "<uri-omitida>").replace(/[A-Za-z0-9.-]+\.mongodb\.net(?::\d+)?/gi, "<host-atlas>");
}

function descrever(erro: unknown): string {
  if (!(erro instanceof Error)) return sanitizar(String(erro));
  const codigo = codigoMongo(erro);
  return sanitizar(`${erro.name}${codigo === null ? "" : ` (código ${codigo})`}: ${erro.message}`);
}

function ehErroDeInfraestrutura(erro: unknown): boolean {
  if (!(erro instanceof Error)) return false;
  if (NOMES_ERRO_INFRAESTRUTURA.has(erro.name)) return true;
  const codigo = codigoMongo(erro);
  return codigo !== null && CODIGOS_ERRO_INFRAESTRUTURA.has(codigo);
}

/**
 * Captura o resultado de uma operação de NEGÓCIO cuja falha faz parte do cenário. Erros de infraestrutura nunca são
 * tratados como resultado do cenário: viram `[INFRAESTRUTURA]` na hora.
 */
async function capturar<T>(promessa: Promise<T>): Promise<Resultado<T>> {
  try {
    return { ok: true, valor: await promessa };
  } catch (erro) {
    if (ehErroDeInfraestrutura(erro)) throw new Error(`[INFRAESTRUTURA] ${descrever(erro)}`);
    return { ok: false, erro };
  }
}

/** Executa uma etapa de ambiente (conexão, limpeza, índices) convertendo erros de infraestrutura em `[INFRAESTRUTURA]`. */
async function comInfraestrutura<T>(etapa: string, acao: () => Promise<T>): Promise<T> {
  try {
    return await acao();
  } catch (erro) {
    if (ehErroDeInfraestrutura(erro)) throw new Error(`[INFRAESTRUTURA] ${etapa}: ${descrever(erro)}`);
    throw erro;
  }
}

/** Corpo de cada teste: mantém erros já rotulados e rotula o resto (infraestrutura ou não classificado), sem dados sensíveis. */
async function classificado(corpo: () => Promise<void>): Promise<void> {
  try {
    await corpo();
  } catch (erro) {
    if (erro instanceof Error && ROTULOS.test(erro.message)) throw erro;
    if (ehErroDeInfraestrutura(erro)) throw new Error(`[INFRAESTRUTURA] ${descrever(erro)}`);
    throw new Error(`[NÃO CLASSIFICADA] ${descrever(erro)}`);
  }
}

function exigir(condicao: boolean, rotulo: "[SETUP]" | "[INJEÇÃO]" | "[PRÉ-CONDIÇÃO]", mensagem: string): void {
  if (!condicao) throw new Error(`${rotulo} ${mensagem}`);
}

/** Verificação final do comportamento CORRETO. Só ela produz `[CARACTERIZAÇÃO F04]` (os valores comparados são só contagens e flags). */
function caracterizar(observado: unknown, esperadoCorreto: unknown): void {
  if (!Bun.deepEquals(observado, esperadoCorreto)) {
    throw new Error(`[CARACTERIZAÇÃO F04] estado persistido diferente do correto — observado ${JSON.stringify(observado)}; esperado ${JSON.stringify(esperadoCorreto)}`);
  }
  expect(observado).toEqual(esperadoCorreto);
}

/** Limpa o banco E2E apagando suas coleções (privilégio `readWrite`). Recusa qualquer conexão cujo banco não seja exatamente `BANCO_E2E`. */
async function limparBancoE2E(conexao: Connection): Promise<void> {
  const db = conexao.db;
  if (conexao.name !== BANCO_E2E || db === undefined || db.databaseName !== BANCO_E2E) {
    throw new Error(`[SETUP] recusado limpar o banco "${conexao.name}" (só "${BANCO_E2E}" pode ser limpo).`);
  }
  const colecoes = await db.listCollections({}, { nameOnly: true }).toArray();
  for (const colecao of colecoes) {
    if (!colecao.name.startsWith("system.")) await db.dropCollection(colecao.name);
  }
}

async function contarColecoes(conexao: Connection): Promise<number> {
  const db = conexao.db;
  if (db === undefined) throw new Error("[SETUP] conexão sem banco associado");
  const colecoes = await db.listCollections({}, { nameOnly: true }).toArray();
  return colecoes.filter((colecao) => !colecao.name.startsWith("system.")).length;
}

let contador = 0;
function unico(): string {
  contador += 1;
  return `${Date.now()}-${contador}`;
}

/**
 * Fase 60.4.3.4.12 — suíte E2E OPT-IN. Sem `MONGODB_URI_E2E_F04` no processo (caso do CI e de qualquer `bun test`
 * comum), a suíte inteira fica marcada como "skip" — explicitamente, nunca como aprovada — em vez de falhar no
 * `beforeAll` por `[SETUP]` (o que deixava o passo de testes do CI vermelho, sem relação com o código). Com a variável
 * definida, nada muda: a validação completa da URI e do banco continua acontecendo em `lerUriE2E()`, antes de qualquer
 * conexão, e os cenários rodam normalmente. Só a PRESENÇA da variável é consultada aqui; o valor nunca é exibido.
 */
const SUITE_E2E_HABILITADA = (process.env[VARIAVEL_URI_E2E] ?? "").trim() !== "";
if (!SUITE_E2E_HABILITADA) {
  console.warn(`[E2E F04] suíte de caracterização IGNORADA: ${VARIAVEL_URI_E2E} não definida neste processo (execução opt-in).`);
}

describe.skipIf(!SUITE_E2E_HABILITADA)(`${PREFIXO} integridade entre venda e estoque (Fase 60.4.3.4.11.1)`, () => {
  let moduleRef: TestingModule | undefined;
  let service: VendasService;
  let repositorio: VendasRepository;
  let produtosService: ProdutosService;
  let vendedoresService: VendedoresService;
  let caixasService: CaixasService;
  let connection: Connection;
  let uriE2E: string;

  // Rastreamento para limpar SÓ o que este arquivo criou.
  const produtoIds: string[] = [];
  const vendedorIds: string[] = [];
  const caixaIds: string[] = [];
  /** Documentos artificiais que T1/T3 inserem em `vendas` para provocar o E11000 — removidos também no `afterAll`. */
  const bloqueioIds: Types.ObjectId[] = [];

  beforeAll(async () => {
    // 1. Validação da variável — antes de qualquer conexão.
    uriE2E = lerUriE2E();

    // 2. Recuperação de execução interrompida: limpa o banco E2E ANTES de o contexto Nest conectar, numa conexão
    //    separada (para não derrubar coleções/índices que o contexto estivesse criando).
    const conexaoDeLimpeza = createConnection(uriE2E, { serverSelectionTimeoutMS: SELECAO_SERVIDOR_MS });
    try {
      await comInfraestrutura("conexão de limpeza ao banco E2E", () => conexaoDeLimpeza.asPromise());
      await comInfraestrutura("limpeza inicial do banco E2E", () => limparBancoE2E(conexaoDeLimpeza));
      exigir((await comInfraestrutura("verificação da limpeza inicial", () => contarColecoes(conexaoDeLimpeza))) === 0, "[SETUP]", "o banco E2E deveria estar sem coleções depois da limpeza inicial");
    } finally {
      await conexaoDeLimpeza.close();
    }

    // 3. Contexto Nest principal. Se qualquer passo daqui em diante falhar, o próprio beforeAll fecha o contexto (não
    //    depende de o Bun executar o afterAll depois de um beforeAll com erro).
    let contexto: TestingModule | undefined;
    try {
      contexto = await comInfraestrutura("contexto Nest principal", () =>
        Test.createTestingModule({ imports: [MongooseModule.forRoot(uriE2E, OPCOES_CONTEXTO_NEST), JWT_MODULO_DE_TESTE, VendasModule] }).compile(),
      );
      const conexaoPrincipal: Connection = contexto.get(getConnectionToken());
      exigir(conexaoPrincipal.name === BANCO_E2E, "[SETUP]", `o contexto principal deveria estar no banco "${BANCO_E2E}"; está em "${conexaoPrincipal.name}"`);
      // Banco recém-limpo: espera a criação das coleções e dos índices dos schemas (T1/T3 dependem do índice único de `vendas.numero`).
      await comInfraestrutura("criação de coleções e índices", () => Promise.all(conexaoPrincipal.modelNames().map((nome) => conexaoPrincipal.model(nome).init())));
      const configuracoesService = contexto.get(ConfiguracoesService);
      await comInfraestrutura("configuração da loja no banco E2E", async () => {
        await garantirItemConfiguracao(configuracoesService, "cores", "Azul");
        await garantirItemConfiguracao(configuracoesService, "tamanhos", "M");
        await garantirItemConfiguracao(configuracoesService, "categorias", "Vestidos");
        await garantirItemConfiguracao(configuracoesService, "formasPagamento", "Dinheiro");
      });

      service = contexto.get(VendasService);
      repositorio = contexto.get(VendasRepository);
      produtosService = contexto.get(ProdutosService);
      vendedoresService = contexto.get(VendedoresService);
      caixasService = contexto.get(CaixasService);
      connection = conexaoPrincipal;
      moduleRef = contexto;
    } catch (erro) {
      if (contexto) await contexto.close();
      throw erro;
    }
  }, { timeout: PRAZO_BEFORE_ALL_MS });

  afterAll(async () => {
    const contexto = moduleRef;
    if (!contexto) return; // o beforeAll falhou e já fechou o que abriu — nada a limpar aqui.
    try {
      await comInfraestrutura("limpeza final do banco E2E", async () => {
        await connection.collection("vendas").deleteMany({ _id: { $in: bloqueioIds } });
        const vendas = await connection.collection<VendaBruta>("vendas").find({ caixaId: { $in: caixaIds } }).toArray();
        const vendaIds = vendas.map((venda) => venda._id);
        await connection.collection("eventos_venda").deleteMany({ vendaId: { $in: vendaIds } });
        await connection.collection("vendas").deleteMany({ _id: { $in: vendaIds } });
        await connection.collection("movimentos_caixa").deleteMany({ caixaId: { $in: caixaIds } });
        await connection.collection("eventos_caixa").deleteMany({ caixaId: { $in: caixaIds.map((id) => new Types.ObjectId(id)) } });
        await connection.collection("caixas").deleteMany({ _id: { $in: caixaIds.map((id) => new Types.ObjectId(id)) } });
        await connection.collection("eventos_produto").deleteMany({ produtoId: { $in: produtoIds.map((id) => new Types.ObjectId(id)) } });
        await connection.collection("produtos").deleteMany({ _id: { $in: produtoIds.map((id) => new Types.ObjectId(id)) } });
        await connection.collection("eventos_vendedor").deleteMany({ vendedorId: { $in: vendedorIds.map((id) => new Types.ObjectId(id)) } });
        await connection.collection("vendedores").deleteMany({ _id: { $in: vendedorIds.map((id) => new Types.ObjectId(id)) } });
        // O banco é exclusivo deste arquivo: apagar as coleções remove também a sequência e a configuração criadas aqui.
        await limparBancoE2E(connection);
      });
    } finally {
      moduleRef = undefined;
      await contexto.close();
    }
  }, { timeout: PRAZO_AFTER_ALL_MS });

  // ---------------------------------------------------------------------------------------------------------------
  // Preparação e leitura direta do banco
  // ---------------------------------------------------------------------------------------------------------------

  async function prepararCenario() {
    const s = unico();
    let produto: Awaited<ReturnType<ProdutosService["criar"]>>;
    try {
      produto = await produtosService.criar({ nome: `Produto Caracterização ${s}`, categoria: "Vestidos", precoCusto: PRECO / 2, precoVenda: PRECO, ehNovidade: false }, null);
    } catch (erro) {
      if (ehErroDeInfraestrutura(erro)) throw new Error(`[INFRAESTRUTURA] criar produto: ${descrever(erro)}`);
      throw new Error(`[SETUP] criar produto: ${descrever(erro)}`);
    }
    produtoIds.push(produto.id);
    const variante = await produtosService.adicionarVariante(produto.id, { cor: "Azul" }, null);
    const varianteId = String(variante._id);
    const { tamanhoId } = await produtosService.ajustarQuantidadeTamanho(produto.id, varianteId, { tamanho: "M", delta: ESTOQUE_INICIAL, exigirExistente: false });

    const telefone = `119${String((Date.now() + contador) % 100_000_000).padStart(8, "0")}`;
    const vendedor = await vendedoresService.criar({ nome: `Vendedor Caracterização ${s}`, telefone, ativo: true, senha: "senha123" }, null);
    vendedorIds.push(vendedor.id);

    const aberto = await capturar(caixasService.abrir({ valorInicial: 0, observacao: "caracterização F04" }, null));
    if (!aberto.ok) throw new Error(`[SETUP] abrir caixa (outro caixa aberto no banco E2E?): ${descrever(aberto.erro)}`);
    caixaIds.push(aberto.valor.id);

    exigir((await saldo(produto.id, tamanhoId)) === ESTOQUE_INICIAL, "[SETUP]", "saldo inicial diferente do preparado");
    return { produtoId: produto.id, varianteId, tamanhoId, vendedorId: vendedor.id, caixaId: aberto.valor.id };
  }

  type Cenario = Awaited<ReturnType<typeof prepararCenario>>;

  function dadosVenda(cenario: Cenario, idempotencyKey: string): DadosCriarVenda {
    return {
      vendedorId: cenario.vendedorId,
      caixaId: cenario.caixaId,
      itens: [{ produtoId: cenario.produtoId, varianteId: cenario.varianteId, tamanhoId: cenario.tamanhoId, quantidade: QUANTIDADE }],
      pagamentos: [{ forma: "Dinheiro", valor: PRECO * QUANTIDADE }],
      idempotencyKey,
    };
  }

  /** Fecha o caixa do cenário (sempre em `finally`): um caixa aberto impediria os próximos testes de abrir o seu. */
  async function fecharCaixa(caixaId: string): Promise<void> {
    const atual = await connection.collection<{ _id: Types.ObjectId; status: string }>("caixas").findOne({ _id: new Types.ObjectId(caixaId) });
    if (atual?.status === "aberto") await caixasService.fechar(caixaId, { valorInformado: 0, observacao: "fechamento do teste de caracterização" }, null);
  }

  async function saldo(produtoId: string, tamanhoId: string): Promise<number> {
    const produto = await connection.collection<ProdutoBruto>("produtos").findOne({ _id: new Types.ObjectId(produtoId) });
    if (!produto) throw new Error(`[SETUP] produto ${produtoId} não encontrado no banco`);
    for (const variante of produto.variantes) {
      for (const tamanho of variante.tamanhos) if (String(tamanho._id) === tamanhoId) return tamanho.quantidade;
    }
    throw new Error(`[SETUP] tamanho ${tamanhoId} não encontrado no produto ${produtoId}`);
  }

  async function vendasDaChave(chave: string): Promise<number> {
    return connection.collection<VendaBruta>("vendas").countDocuments({ idempotencyKey: chave });
  }

  async function movimentosDaChave(chave: string): Promise<number> {
    return connection.collection("movimentos_caixa").countDocuments({ idempotencyKey: { $regex: `^${chave}:pagamento:` } });
  }

  async function vendasDoVendedor(vendedorId: string): Promise<number> {
    const vendedor = await connection.collection<VendedorBruto>("vendedores").findOne({ _id: new Types.ObjectId(vendedorId) });
    return vendedor?.vendas ?? -1;
  }

  async function flagsDoPrimeiroItemCancelado(vendaId: string): Promise<{ restaurado: boolean; restaurando: boolean } | null> {
    const venda = await connection.collection<VendaBruta>("vendas").findOne({ _id: new Types.ObjectId(vendaId) });
    const item = venda?.cancelamentos?.[0]?.itens[0];
    return item ? { restaurado: item.restaurado, restaurando: item.restaurando } : null;
  }

  /**
   * Injeção por ESTADO REAL: pré-insere um documento em `vendas` com o `numero` que a sequência vai gerar na próxima
   * venda. O insert da venda real (etapa 6, DEPOIS da baixa) recebe E11000 em `numero` — uma chave única que NÃO é
   * `idempotencyKey`, portanto relançada por `VendasRepository.criar` sem compensação.
   */
  async function bloquearProximoNumero(marca: string): Promise<{ bloqueioId: Types.ObjectId; numero: string }> {
    const indices = await connection.collection("vendas").indexes();
    exigir(indices.some((indice) => indice.unique === true && indice.key["numero"] === 1), "[SETUP]", "índice único de vendas.numero ausente — a injeção por E11000 não funcionaria");
    const sequencia = await connection.collection<SequenciaBruta>("sequencias").findOne({ _id: CHAVE_SEQUENCIA_VENDA });
    const atual = typeof sequencia?.valor === "number" ? sequencia.valor : 0;
    const numero = String(atual + 1).padStart(DIGITOS_NUMERO_VENDA, "0");
    exigir((await connection.collection("vendas").countDocuments({ numero })) === 0, "[SETUP]", `já existe venda com numero ${numero}`);
    const bloqueioId = new Types.ObjectId();
    // Registrado ANTES do insert: se o processo cair logo depois, o `afterAll` (ou o `beforeAll` seguinte) ainda o remove.
    bloqueioIds.push(bloqueioId);
    await connection.collection<VendaBruta>("vendas").insertOne({ _id: bloqueioId, codigo: `CARACT-BLOQUEIO-${marca}`, numero });
    return { bloqueioId, numero };
  }

  function exigirE11000EmNumero(resultado: Resultado<unknown>): void {
    exigir(!resultado.ok, "[INJEÇÃO]", "a venda deveria ter falhado no insert por E11000 em `numero`, mas foi criada");
    if (resultado.ok) return;
    exigir(
      codigoMongo(resultado.erro) === 11000 && descrever(resultado.erro).includes("numero"),
      "[INJEÇÃO]",
      `esperado E11000 em \`numero\`; recebido ${descrever(resultado.erro)}`,
    );
  }

  // ---------------------------------------------------------------------------------------------------------------
  // T1 — falha na gravação da venda DEPOIS da baixa (cenário 1; evidência E1/E3)
  // ---------------------------------------------------------------------------------------------------------------
  it(`${PREFIXO} T1: falha no insert da venda depois da baixa NÃO pode deixar o estoque baixado sem venda`, () => classificado(async () => {
    const cenario = await prepararCenario();
    const chave = `caract-t1-${unico()}`;
    const { bloqueioId } = await bloquearProximoNumero(chave);
    try {
      const resultado = await capturar(service.criar(dadosVenda(cenario, chave), null));
      exigirE11000EmNumero(resultado);

      const observado = { saldo: await saldo(cenario.produtoId, cenario.tamanhoId), vendasComAChave: await vendasDaChave(chave) };
      // Correto: a venda não existe, então nenhuma unidade pode ter saído do estoque.
      // Hoje (defeito): saldo = ESTOQUE_INICIAL − QUANTIDADE, sem venda e sem registro da baixa.
      caracterizar(observado, { saldo: ESTOQUE_INICIAL, vendasComAChave: 0 });
    } finally {
      await connection.collection("vendas").deleteOne({ _id: bloqueioId });
      await fecharCaixa(cenario.caixaId);
    }
  }), PRAZO_TESTE_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // T3 — retry com a MESMA chave depois da falha de T1 (cenário 3)
  // ---------------------------------------------------------------------------------------------------------------
  it(`${PREFIXO} T3: retry com a mesma idempotencyKey após a falha NÃO pode baixar o estoque uma segunda vez`, () => classificado(async () => {
    const cenario = await prepararCenario();
    const chave = `caract-t3-${unico()}`;
    const { bloqueioId } = await bloquearProximoNumero(chave);
    try {
      exigirE11000EmNumero(await capturar(service.criar(dadosVenda(cenario, chave), null)));
      exigir((await vendasDaChave(chave)) === 0, "[PRÉ-CONDIÇÃO]", "nenhuma venda deveria existir depois da primeira tentativa");

      // A causa da falha desaparece (como um Mongo que volta) e o PDV reenvia a MESMA operação.
      await connection.collection("vendas").deleteOne({ _id: bloqueioId });
      const retry = await capturar(service.criar(dadosVenda(cenario, chave), null));
      exigir(retry.ok, "[PRÉ-CONDIÇÃO]", `o retry deveria criar a venda; falhou com ${retry.ok ? "" : descrever(retry.erro)}`);

      const observado = {
        saldo: await saldo(cenario.produtoId, cenario.tamanhoId),
        vendasComAChave: await vendasDaChave(chave),
        movimentosDeCaixaDaChave: await movimentosDaChave(chave),
      };
      // Correto: UMA venda, UMA baixa, UM movimento. Hoje (defeito): saldo = ESTOQUE_INICIAL − 2 × QUANTIDADE.
      caracterizar(observado, { saldo: ESTOQUE_INICIAL - QUANTIDADE, vendasComAChave: 1, movimentosDeCaixaDaChave: 1 });
    } finally {
      await connection.collection("vendas").deleteOne({ _id: bloqueioId });
      await fecharCaixa(cenario.caixaId);
    }
  }), PRAZO_TESTE_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // T5 — duas INSTÂNCIAS (dois contextos Nest) com a mesma chave (cenário 5; evidência E2/E4)
  // ---------------------------------------------------------------------------------------------------------------
  it(`${PREFIXO} T5: duas instâncias com a mesma idempotencyKey NÃO podem baixar o estoque duas vezes`, () => classificado(async () => {
    const cenario = await prepararCenario();
    const chave = `caract-t5-${unico()}`;
    let moduloB: TestingModule | null = null;
    const pontoA = novoPonto();
    const pontoB = novoPonto();
    const espioes: { mockRestore(): void }[] = [];
    try {
      try {
        moduloB = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uriE2E, OPCOES_CONTEXTO_NEST), JWT_MODULO_DE_TESTE, VendasModule] }).compile();
      } catch (erro) {
        if (ehErroDeInfraestrutura(erro)) throw new Error(`[INFRAESTRUTURA] segundo contexto Nest: ${descrever(erro)}`);
        throw new Error(`[SETUP] segundo contexto Nest: ${descrever(erro)}`);
      }
      const serviceB = moduloB.get(VendasService);
      const repositorioB = moduloB.get(VendasRepository);
      const conexaoB: Connection = moduloB.get(getConnectionToken());
      exigir(serviceB !== service && repositorioB !== repositorio, "[SETUP]", "os dois contextos deveriam ter instâncias distintas");
      exigir(conexaoB !== connection && conexaoB.name === BANCO_E2E && connection.name === BANCO_E2E, "[SETUP]", "os dois contextos deveriam ter conexões distintas no mesmo banco E2E");

      // Cada instância pausa no insert da venda (etapa 6) — DEPOIS de já ter baixado o estoque (etapa 4).
      const criarA = repositorio.criar.bind(repositorio);
      const criarB = repositorioB.criar.bind(repositorioB);
      espioes.push(spyOn(repositorio, "criar").mockImplementation(async (dados) => {
        pontoA.chegou.liberar();
        await pontoA.liberacao.promessa;
        return criarA(dados);
      }));
      espioes.push(spyOn(repositorioB, "criar").mockImplementation(async (dados) => {
        pontoB.chegou.liberar();
        await pontoB.liberacao.promessa;
        return criarB(dados);
      }));

      // A baixa e para antes do insert; só então B começa (A ainda não gravou: B não encontra a venda pela chave).
      const execucaoA = capturar(service.criar(dadosVenda(cenario, chave), null));
      await pontoA.chegou.promessa;
      const execucaoB = capturar(serviceB.criar(dadosVenda(cenario, chave), null));
      await pontoB.chegou.promessa;
      exigir((await saldo(cenario.produtoId, cenario.tamanhoId)) === ESTOQUE_INICIAL - 2 * QUANTIDADE, "[PRÉ-CONDIÇÃO]", "as duas instâncias deveriam ter baixado antes do insert");

      // A grava primeiro; B grava depois e recebe E11000 de idempotencyKey → devolve a venda de A.
      pontoA.liberacao.liberar();
      const resultadoA = await execucaoA;
      pontoB.liberacao.liberar();
      const resultadoB = await execucaoB;
      exigir(resultadoA.ok && resultadoB.ok, "[PRÉ-CONDIÇÃO]", `as duas chamadas deveriam concluir; A=${resultadoA.ok ? "ok" : descrever(resultadoA.erro)} B=${resultadoB.ok ? "ok" : descrever(resultadoB.erro)}`);
      exigir(resultadoA.ok && resultadoB.ok && resultadoA.valor.id === resultadoB.valor.id, "[PRÉ-CONDIÇÃO]", "B deveria devolver a mesma venda de A");

      const observado = {
        saldo: await saldo(cenario.produtoId, cenario.tamanhoId),
        vendasComAChave: await vendasDaChave(chave),
        movimentosDeCaixaDaChave: await movimentosDaChave(chave),
        vendasNoAgregadoDoVendedor: await vendasDoVendedor(cenario.vendedorId),
      };
      // Correto: uma venda ⇒ uma baixa e uma contagem no agregado. Hoje (defeito): a baixa de B não é desfeita
      // (saldo = ESTOQUE_INICIAL − 2 × QUANTIDADE) e o agregado do vendedor também é incrementado duas vezes.
      caracterizar(observado, { saldo: ESTOQUE_INICIAL - QUANTIDADE, vendasComAChave: 1, movimentosDeCaixaDaChave: 1, vendasNoAgregadoDoVendedor: 1 });
    } finally {
      liberarTudo(pontoA, pontoB);
      for (const espiao of espioes.splice(0)) espiao.mockRestore();
      if (moduloB) await moduloB.close();
      await fecharCaixa(cenario.caixaId);
    }
  }), PRAZO_TESTE_T5_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // T7 — falha na geração da sequência DEPOIS da baixa (cenário 7)
  // ---------------------------------------------------------------------------------------------------------------
  it(`${PREFIXO} T7: falha de sequenciasService.proximoValor depois da baixa NÃO pode deixar o estoque baixado sem venda`, () => classificado(async () => {
    const cenario = await prepararCenario();
    const chave = `caract-t7-${unico()}`;
    const sequencias = connection.collection<SequenciaBruta>("sequencias");
    const original = await sequencias.findOne({ _id: CHAVE_SEQUENCIA_VENDA });
    try {
      // Injeção por ESTADO REAL: `$inc` sobre um valor não numérico falha no servidor (TypeMismatch, código 14).
      // Altera SÓ `sequencias.venda` do banco E2E (`connection` é a conexão validada do banco `mariela_e2e_f04`): uma
      // interrupção abrupta aqui não afeta nenhum outro banco, e a próxima execução limpa o banco E2E no `beforeAll`.
      await sequencias.updateOne({ _id: CHAVE_SEQUENCIA_VENDA }, { $set: { valor: "nao-numerico-caracterizacao" } }, { upsert: true });
      const resultado = await capturar(service.criar(dadosVenda(cenario, chave), null));
      exigir(!resultado.ok, "[INJEÇÃO]", "a venda deveria ter falhado na geração da sequência");
      if (!resultado.ok) {
        exigir(codigoMongo(resultado.erro) === 14, "[INJEÇÃO]", `esperado TypeMismatch (14) do $inc; recebido ${descrever(resultado.erro)}`);
      }

      const observado = { saldo: await saldo(cenario.produtoId, cenario.tamanhoId), vendasComAChave: await vendasDaChave(chave) };
      // Correto: sem venda, sem baixa. Hoje (defeito): saldo = ESTOQUE_INICIAL − QUANTIDADE.
      caracterizar(observado, { saldo: ESTOQUE_INICIAL, vendasComAChave: 0 });
    } finally {
      if (original) await sequencias.updateOne({ _id: CHAVE_SEQUENCIA_VENDA }, { $set: { valor: original.valor } });
      else await sequencias.deleteOne({ _id: CHAVE_SEQUENCIA_VENDA });
      await fecharCaixa(cenario.caixaId);
    }
  }), PRAZO_TESTE_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // T10a — falha em marcarItemRestaurado DEPOIS da devolução persistida (cenário 10-i; evidência E7)
  // ---------------------------------------------------------------------------------------------------------------
  it(`${PREFIXO} T10a: falha ao marcar o item restaurado NÃO pode levar a reconciliação a devolver o estoque de novo`, () => classificado(async () => {
    const cenario = await prepararCenario();
    const espioes: { mockRestore(): void }[] = [];
    try {
      const venda = await service.criar(dadosVenda(cenario, `caract-t10a-venda-${unico()}`), null);
      exigir((await saldo(cenario.produtoId, cenario.tamanhoId)) === ESTOQUE_INICIAL - QUANTIDADE, "[PRÉ-CONDIÇÃO]", "a venda deveria ter baixado o estoque");
      const cancelamento: CancelamentoDto = { tipo: "integral", motivo: "caracterização T10a", idempotencyKey: `caract-t10a-cancel-${unico()}` };

      // Falha pontual e controlada: SÓ a primeira chamada a `marcarItemRestaurado` falha, depois de
      // `devolverAoEstoque` já ter gravado a devolução no produto (simula erro transitório nessa escrita).
      let falhasInjetadas = 0;
      const marcarOriginal = repositorio.marcarItemRestaurado.bind(repositorio);
      espioes.push(spyOn(repositorio, "marcarItemRestaurado").mockImplementation(async (vendaId, eventoId, itemId) => {
        if (falhasInjetadas === 0) {
          falhasInjetadas += 1;
          throw new Error("[INJETADO] falha transitória simulada em marcarItemRestaurado");
        }
        return marcarOriginal(vendaId, eventoId, itemId);
      }));

      const primeira = await capturar(service.cancelar(venda.id, cancelamento, null));
      for (const espiao of espioes.splice(0)) espiao.mockRestore();
      exigir(falhasInjetadas === 1, "[INJEÇÃO]", `esperada 1 falha injetada em marcarItemRestaurado; ocorreram ${falhasInjetadas}`);
      exigir(primeira.ok, "[PRÉ-CONDIÇÃO]", `o cancelamento deveria concluir (a falha de restauração é só logada); ${primeira.ok ? "" : descrever(primeira.erro)}`);
      const saldoAposPrimeira = await saldo(cenario.produtoId, cenario.tamanhoId);
      const flagsAposPrimeira = await flagsDoPrimeiroItemCancelado(venda.id);
      exigir(saldoAposPrimeira === ESTOQUE_INICIAL, "[PRÉ-CONDIÇÃO]", `a devolução deveria ter sido gravada uma vez (saldo ${ESTOQUE_INICIAL}); saldo ${saldoAposPrimeira}`);
      exigir(
        flagsAposPrimeira?.restaurado === false && flagsAposPrimeira.restaurando === false,
        "[PRÉ-CONDIÇÃO]",
        `após a falha o item deveria estar restaurado=false/restaurando=false; ${JSON.stringify(flagsAposPrimeira)}`,
      );

      // Reconciliação: o mesmo cancelamento repetido (mesma chave) — caminho de replay.
      const reconciliacao = await capturar(service.cancelar(venda.id, cancelamento, null));
      exigir(reconciliacao.ok, "[PRÉ-CONDIÇÃO]", `a reconciliação deveria concluir; ${reconciliacao.ok ? "" : descrever(reconciliacao.erro)}`);

      const observado = { saldo: await saldo(cenario.produtoId, cenario.tamanhoId), flags: await flagsDoPrimeiroItemCancelado(venda.id) };
      // Correto: a devolução já gravada não se repete. Hoje (defeito): saldo = ESTOQUE_INICIAL + QUANTIDADE.
      caracterizar(observado, { saldo: ESTOQUE_INICIAL, flags: { restaurado: true, restaurando: false } });
    } finally {
      for (const espiao of espioes.splice(0)) espiao.mockRestore();
      await fecharCaixa(cenario.caixaId);
    }
  }), PRAZO_TESTE_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // T10b — reivindicação órfã `restaurando:true` (cenário 10-ii / 11; evidência E8)
  // ---------------------------------------------------------------------------------------------------------------
  it(`${PREFIXO} T10b: reivindicação órfã (restaurando:true) precisa ser retomada pela reconciliação`, () => classificado(async () => {
    const cenario = await prepararCenario();
    const espioes: { mockRestore(): void }[] = [];
    try {
      const venda = await service.criar(dadosVenda(cenario, `caract-t10b-venda-${unico()}`), null);
      exigir((await saldo(cenario.produtoId, cenario.tamanhoId)) === ESTOQUE_INICIAL - QUANTIDADE, "[PRÉ-CONDIÇÃO]", "a venda deveria ter baixado o estoque");
      const cancelamento: CancelamentoDto = { tipo: "integral", motivo: "caracterização T10b", idempotencyKey: `caract-t10b-cancel-${unico()}` };

      // Simula a queda do processo LOGO DEPOIS de a reivindicação ser gravada (antes da devolução física):
      // a reivindicação real é persistida e, em seguida, a operação é interrompida.
      // Revisão estática (vendas.service.ts): `reivindicarRestauracaoDeItem` é chamada FORA do `try` de
      // `restaurarEstoquePendente` (linha 1177; o `try` começa na 1181), e nem `cancelar` (1084) nem
      // `reconciliarCancelamento` (1147) capturam erros desse ponto — então esta exceção sobe sem passar por
      // `liberarReivindicacaoDeItem`, e `restaurando:true` permanece gravado, como numa queda real. O mesmo caminho
      // ocorre numa falha de rede cuja escrita foi aplicada mas cuja resposta se perdeu.
      let quedasInjetadas = 0;
      const reivindicarOriginal = repositorio.reivindicarRestauracaoDeItem.bind(repositorio);
      espioes.push(spyOn(repositorio, "reivindicarRestauracaoDeItem").mockImplementation(async (vendaId, eventoId, itemId) => {
        const reivindicado = await reivindicarOriginal(vendaId, eventoId, itemId);
        if (quedasInjetadas === 0) {
          quedasInjetadas += 1;
          throw new Error("[INJETADO] queda simulada do processo logo após a reivindicação");
        }
        return reivindicado;
      }));

      const primeira = await capturar(service.cancelar(venda.id, cancelamento, null));
      for (const espiao of espioes.splice(0)) espiao.mockRestore();
      exigir(quedasInjetadas === 1, "[INJEÇÃO]", `esperada 1 queda injetada; ocorreram ${quedasInjetadas}`);
      exigir(!primeira.ok && descrever(primeira.erro).includes("[INJETADO]"), "[INJEÇÃO]", "a primeira tentativa deveria terminar pela queda injetada");
      const flagsOrfaos = await flagsDoPrimeiroItemCancelado(venda.id);
      exigir(
        flagsOrfaos?.restaurado === false && flagsOrfaos.restaurando === true,
        "[PRÉ-CONDIÇÃO]",
        `o item deveria estar órfão (restaurado=false/restaurando=true); ${JSON.stringify(flagsOrfaos)}`,
      );
      exigir((await saldo(cenario.produtoId, cenario.tamanhoId)) === ESTOQUE_INICIAL - QUANTIDADE, "[PRÉ-CONDIÇÃO]", "nenhuma devolução física deveria ter ocorrido antes da queda");

      // Reconciliação depois do "reinício": mesma operação, mesma chave.
      const reconciliacao = await capturar(service.cancelar(venda.id, cancelamento, null));
      exigir(reconciliacao.ok, "[PRÉ-CONDIÇÃO]", `a reconciliação deveria concluir; ${reconciliacao.ok ? "" : descrever(reconciliacao.erro)}`);

      const observado = { saldo: await saldo(cenario.produtoId, cenario.tamanhoId), flags: await flagsDoPrimeiroItemCancelado(venda.id) };
      // Correto: a reconciliação retoma a linha órfã e devolve o estoque uma vez.
      // Hoje (defeito): o item continua restaurando=true para sempre e o saldo fica em ESTOQUE_INICIAL − QUANTIDADE.
      caracterizar(observado, { saldo: ESTOQUE_INICIAL, flags: { restaurado: true, restaurando: false } });
    } finally {
      for (const espiao of espioes.splice(0)) espiao.mockRestore();
      await fecharCaixa(cenario.caixaId);
    }
  }), PRAZO_TESTE_MS);
});
