import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { fileURLToPath } from "node:url";
import type { Connection } from "mongoose";
import { AppModule } from "../app.module.js";
import { AuthService } from "../modules/auth/auth.service.js";
import { MONGODB_URI_TESTE } from "../test-utils/mongo-teste.util.js";
import { analisarUri, type AmbienteDeExecucao } from "./comando-local.util.js";
import {
  abrirContextoDoComando,
  CODIGOS_DE_SAIDA,
  criarAbridorDeContexto,
  executarComando,
  interpretarVariaveis,
  LIMITES,
  type AbrirContexto,
} from "./seed-admin.comando.js";

/**
 * Fase 60.4.3.2.1 — comando `seed:admin` em contexto mínimo.
 *
 * - Recusas: um abridor que só REGISTRA a chamada e se recusa a conectar prova que toda recusa acontece antes de
 *   qualquer conexão. Nenhum teste conecta a um banco que não seja `mariela_test` local.
 * - Integração: o contexto REAL do comando contra `mariela_test`, com o driver e o Mongoose instrumentados para
 *   provar que nem a inicialização nem o dry-run criam coleções/índices, e que o `--apply` só escreve o usuário e a
 *   sequência. O `AppModule` aqui é só do PRÓPRIO teste (para o login real e as conferências), nunca do comando.
 */

const BANCO_DE_TESTE = "mariela_test";
const URI_PRODUCAO = "mongodb+srv://usuario_app:SenhaSecretaDoAtlas123@cluster0.exemplo.mongodb.net/marielaDB?retryWrites=true&w=majority";
const SENHA = "senha-do-seed-9f3k2"; // nunca pode aparecer em nenhuma saída
const PREFIXO_EMAIL = "teste.seed-cmd.";
const NOME = "ADMIN TEMPORARIO TESTE";
const contextoLogin = { ip: "127.0.0.1", userAgent: "bun-test-seed" };

const EXECUCAO_LOCAL: AmbienteDeExecucao = {
  arquivoDeEntrada: fileURLToPath(new URL("./seed-admin.ts", import.meta.url)),
  variaveis: {},
  existeArquivo: () => false,
};

let contador = 0;
function emailUnico(sufixo: string): string {
  contador += 1;
  return `${PREFIXO_EMAIL}${sufixo}.${Date.now()}.${contador}@mariela.dev`;
}

function abridorQueNaoConecta() {
  const chamadas: string[] = [];
  const abrir: AbrirContexto = async (uri) => {
    chamadas.push(uri);
    throw new Error("este teste não pode abrir conexão");
  };
  return { abrir, chamadas };
}

function variaveisDeCriacao(email: string, extras: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { MONGODB_URI: MONGODB_URI_TESTE, ADMIN_EMAIL: email, ADMIN_NAME: NOME, ADMIN_PASSWORD: SENHA, ADMIN_SEED_CONFIRM: email, ...extras };
}

async function executar(argv: string[], variaveis: Record<string, string | undefined>, abrir: AbrirContexto, execucao: AmbienteDeExecucao = EXECUCAO_LOCAL) {
  const saida: string[] = [];
  const codigo = await executarComando({ argv, variaveis, escrever: (linha) => saida.push(linha), abrirContexto: abrir, execucao });
  const texto = saida.join("\n");
  expect(texto).not.toContain(SENHA);
  return { codigo, texto };
}

const ARGS_DRY_RUN = ["--banco", BANCO_DE_TESTE];
const ARGS_APPLY = ["--banco", BANCO_DE_TESTE, "--apply"];

/** Comandos do protocolo que criam/alteram coleções ou índices — proibidos em qualquer momento do comando. */
const COMANDOS_DE_ESTRUTURA = ["createIndexes", "dropIndexes", "listIndexes", "create", "drop", "dropDatabase", "collMod", "renameCollection"];
const COMANDOS_DE_ESCRITA = ["insert", "update", "delete", "findAndModify", "bulkWrite"];
const COMANDOS_DE_LEITURA_ACEITOS = new Set(["find", "getMore", "killCursors", "aggregate", "count", "distinct", "endSessions"]);
const METODOS_MONGOOSE_DE_ESTRUTURA = ["createIndex", "createIndexes", "ensureIndexes", "syncIndexes", "dropIndex", "dropIndexes", "createCollection"];

function instrumentado() {
  const comandos: { nome: string; colecao: unknown }[] = [];
  const metodos: string[] = [];
  const conexoes: Connection[] = [];
  let comandosAteContextoPronto: number | null = null;
  const abrir = criarAbridorDeContexto({
    aoConectar: (conexao) => {
      conexoes.push(conexao);
      conexao.set("debug", (_colecao: string, metodo: string) => {
        metodos.push(metodo);
      });
      conexao.getClient().on("commandStarted", (evento: { commandName: string; command: Record<string, unknown> }) => {
        comandos.push({ nome: evento.commandName, colecao: evento.command[evento.commandName] });
      });
    },
    aoCriar: () => {
      comandosAteContextoPronto = comandos.length;
    },
  });
  return {
    abrir,
    comandos,
    metodos,
    conexoes,
    inicializacao: () => comandos.slice(0, comandosAteContextoPronto ?? 0),
  };
}

describe("comando seed:admin em contexto mínimo (Fase 60.4.3.2.1)", () => {
  it("pré-condição: os testes de integração usam exclusivamente mariela_test em host local", () => {
    expect(analisarUri(MONGODB_URI_TESTE)).toEqual({ banco: BANCO_DE_TESTE, local: true });
  });

  describe("recusas ANTES de qualquer conexão", () => {
    const email = "novo.admin@mariela.dev";

    it("execução fora do código-fonte ou em ambiente implantado é recusada (dist, NODE_ENV, Render, Docker)", async () => {
      const cenarios: AmbienteDeExecucao[] = [
        { ...EXECUCAO_LOCAL, arquivoDeEntrada: "C:\\app\\dist\\scripts\\seed-admin.js" },
        { ...EXECUCAO_LOCAL, variaveis: { NODE_ENV: "production" } },
        { ...EXECUCAO_LOCAL, variaveis: { RENDER: "true" } },
        { ...EXECUCAO_LOCAL, existeArquivo: (caminho: string) => caminho === "/.dockerenv" },
      ];
      for (const execucao of cenarios) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeCriacao(email), abridor.abrir, execucao);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain("Nenhuma conexão foi aberta");
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("a invocação antiga (sem --banco) é recusada com o uso; parâmetros desconhecidos ou repetidos também", async () => {
      for (const argv of [[], ["--apply"], ["--banco", BANCO_DE_TESTE, "--forcar"], ["--banco", "a", "--banco", "b"], ["--banco", BANCO_DE_TESTE, "--confirmar-producao", BANCO_DE_TESTE]]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(argv, variaveisDeCriacao(email), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(abridor.chamadas).toEqual([]);
        if (argv.length === 0) expect(texto).toContain("Uso: bun run seed:admin --banco");
      }
    });

    it("e-mail ausente ou inválido e nome ausente ou longo são recusados (inclusive no dry-run)", async () => {
      const casos: Record<string, string | undefined>[] = [
        { ADMIN_EMAIL: undefined },
        { ADMIN_EMAIL: "sem-arroba" },
        { ADMIN_EMAIL: "dois@@x" },
        { ADMIN_EMAIL: "com espaco@x.y" },
        { ADMIN_NAME: undefined },
        { ADMIN_NAME: "   " },
        { ADMIN_NAME: "x".repeat(LIMITES.nomeMaximo + 1) },
      ];
      for (const extras of casos) {
        const abridor = abridorQueNaoConecta();
        const { codigo } = await executar(ARGS_DRY_RUN, variaveisDeCriacao(email, extras), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("senha: ausente no --apply, menor que 8 ou maior que 200 é recusada, sem ecoar o valor", async () => {
      for (const senha of [undefined, "", "curta77", "x".repeat(LIMITES.senhaMaxima + 1)]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeCriacao(email, { ADMIN_PASSWORD: senha }), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain("ADMIN_PASSWORD");
        if (senha) expect(texto).not.toContain(senha);
        expect(abridor.chamadas).toEqual([]);
      }
      // No dry-run a senha é opcional, mas se vier é validada.
      expect(interpretarVariaveis(variaveisDeCriacao(email, { ADMIN_PASSWORD: undefined }), false).ok).toBe(true);
      expect(interpretarVariaveis(variaveisDeCriacao(email, { ADMIN_PASSWORD: "curta77" }), false).ok).toBe(false);
    });

    it("--apply exige a confirmação explícita do MESMO e-mail", async () => {
      for (const confirmacao of [undefined, "", "outro@mariela.dev", "sim"]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeCriacao(email, { ADMIN_SEED_CONFIRM: confirmacao }), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain("ADMIN_SEED_CONFIRM");
        expect(abridor.chamadas).toEqual([]);
      }
      expect(interpretarVariaveis(variaveisDeCriacao(email, { ADMIN_SEED_CONFIRM: ` ${email.toUpperCase()} ` }), true).ok).toBe(true);
    });

    it("banco: URI ausente, banco divergente da URI e mariela_dev_local são recusados", async () => {
      const casos: { argv: string[]; uri: string | undefined }[] = [
        { argv: ARGS_DRY_RUN, uri: undefined },
        { argv: ["--banco", "outro_banco"], uri: MONGODB_URI_TESTE },
        { argv: ["--banco", "mariela_dev_local"], uri: "mongodb://127.0.0.1:27017/mariela_dev_local" },
        { argv: ARGS_DRY_RUN, uri: "mongodb://127.0.0.1:27017/mariela_dev_local" },
      ];
      for (const caso of casos) {
        const abridor = abridorQueNaoConecta();
        const { codigo } = await executar(caso.argv, variaveisDeCriacao(email, { MONGODB_URI: caso.uri }), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("produção: --apply sem a confirmação exata é recusado; só a combinação exata autoriza; URI e senha nunca aparecem", async () => {
      const variaveis = variaveisDeCriacao(email, { MONGODB_URI: URI_PRODUCAO });
      for (const argv of [["--banco", "marielaDB", "--apply"], ["--banco", "marielaDB", "--apply", "--confirmar-producao", "marieladb"]]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(argv, variaveis, abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).not.toContain("SenhaSecretaDoAtlas123");
        expect(abridor.chamadas).toEqual([]);
      }
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar(["--banco", "marielaDB", "--apply", "--confirmar-producao", "marielaDB"], variaveis, abridor.abrir);
      expect(abridor.chamadas).toEqual([URI_PRODUCAO]); // autorizado; o abridor do teste se recusa a conectar
      expect(codigo).toBe(CODIGOS_DE_SAIDA.falha);
      expect(texto).toContain("PROTEGIDO");
      expect(texto).not.toContain("SenhaSecretaDoAtlas123");
      expect(texto).not.toContain("mongodb+srv://");
    });

    it("`bun run seed:admin` NÃO carrega o .env (--no-env-file): sem variáveis no processo, recusa antes de conectar", async () => {
      // O .env local deste repositório pode definir ADMIN_* e MONGODB_URI; o filho recebe o ambiente SEM elas.
      const ambiente: Record<string, string> = {};
      for (const [nome, valor] of Object.entries(process.env)) {
        if (valor !== undefined && !nome.startsWith("ADMIN_") && nome !== "MONGODB_URI") ambiente[nome] = valor;
      }
      const processo = Bun.spawn(["bun", "run", "seed:admin", "--banco", BANCO_DE_TESTE], { cwd: fileURLToPath(new URL("../..", import.meta.url)), env: ambiente, stdout: "pipe", stderr: "pipe" });
      const saida = await new Response(processo.stdout).text();
      expect(await processo.exited).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(saida).toContain("Defina ADMIN_EMAIL");
    });
  });

  describe("integração com mariela_test (contexto real e mínimo do comando)", () => {
    let moduleRef: TestingModule;
    let auth: AuthService;
    let connection: Connection;

    beforeAll(async () => {
      process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      auth = moduleRef.get(AuthService);
      connection = moduleRef.get(getConnectionToken());
      // Fase 22.1.2 — a fotografia "antes" só é válida depois que os models do PRÓPRIO AppModule do teste terminaram de
      // criar coleções/índices (autoCreate/autoIndex rodam em segundo plano e o compile() não os aguarda). `init()`
      // devolve a mesma promessa da inicialização automática: não recria nada.
      await Promise.all(Object.values(connection.models).map((model) => model.init()));
    });

    afterAll(async () => {
      await connection.collection("usuarios").deleteMany({ email: { $regex: `^${PREFIXO_EMAIL.replaceAll(".", "\\.")}` } });
      await moduleRef.close();
    });

    const valorDaSequencia = async () => (await connection.collection<{ _id: string; valor: number }>("sequencias").findOne({ _id: "usuario" }))?.valor ?? 0;

    async function fotografia() {
      const colecoes = (await connection.db!.listCollections({}, { nameOnly: true }).toArray()).map((colecao) => colecao.name).sort();
      const contagens: Record<string, number> = {};
      for (const nome of colecoes) contagens[nome] = await connection.collection(nome).countDocuments();
      const indices: Record<string, string[]> = {};
      for (const nome of ["usuarios", "sequencias", "caixas", "movimentos_caixa"]) {
        if (colecoes.includes(nome)) indices[nome] = (await connection.collection(nome).indexes()).map((indice) => indice.name ?? "").sort();
      }
      return { colecoes, contagens, indices };
    }

    it("dry-run: só leituras (nem na inicialização há comando de coleção/índice); prevê o código; nada muda", async () => {
      const email = emailUnico("dry-run");
      const antes = await fotografia();
      const sequenciaAntes = await valorDaSequencia();
      const instr = instrumentado();

      const { codigo, texto } = await executar(ARGS_DRY_RUN, variaveisDeCriacao(email, { ADMIN_PASSWORD: undefined, ADMIN_SEED_CONFIRM: undefined }), instr.abrir);

      expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(texto).toContain(`código previsto USR-${String(sequenciaAntes + 1).padStart(4, "0")}`);
      expect(texto).toContain("Dry-run: nada foi alterado.");
      const nomes = instr.comandos.map((comando) => comando.nome);
      expect(instr.inicializacao()).toEqual([]); // a inicialização do contexto não envia NENHUM comando
      expect(nomes).toContain("find");
      expect(nomes.filter((nome) => !COMANDOS_DE_LEITURA_ACEITOS.has(nome))).toEqual([]);
      expect(instr.metodos.filter((metodo) => METODOS_MONGOOSE_DE_ESTRUTURA.includes(metodo))).toEqual([]);
      expect(await fotografia()).toEqual(antes);
      expect(await valorDaSequencia()).toBe(sequenciaAntes);
      expect(instr.conexoes.map((conexao) => conexao.readyState)).toEqual([0]);
    });

    it("--apply: cria o ADMIN (USR-####, Argon2id, ativo) escrevendo SÓ o usuário e a sequência; o login funciona", async () => {
      const email = emailUnico("apply");
      const antes = await fotografia();
      const sequenciaAntes = await valorDaSequencia();
      const instr = instrumentado();

      const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeCriacao(`  ${email.toUpperCase()}  `), instr.abrir);

      const codigoEsperado = `USR-${String(sequenciaAntes + 1).padStart(4, "0")}`;
      expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(texto).toContain(`Administrador criado: ${codigoEsperado} <${email}>`);
      expect(texto).toContain("Perfil: ADMIN; ativo: true");

      // Comandos: nenhum de estrutura; as únicas escritas são a sequência (findAndModify) e o usuário (insert).
      expect(instr.inicializacao()).toEqual([]);
      expect(instr.comandos.filter((comando) => COMANDOS_DE_ESTRUTURA.includes(comando.nome))).toEqual([]);
      expect(instr.comandos.filter((comando) => COMANDOS_DE_ESCRITA.includes(comando.nome))).toEqual([
        { nome: "findAndModify", colecao: "sequencias" },
        { nome: "insert", colecao: "usuarios" },
      ]);
      expect(instr.metodos.filter((metodo) => METODOS_MONGOOSE_DE_ESTRUTURA.includes(metodo))).toEqual([]);

      // Documento gravado.
      const usuario = await connection.collection("usuarios").findOne({ email });
      expect(usuario).toMatchObject({ codigo: codigoEsperado, nome: NOME, email, role: "ADMIN", ativo: true, ultimoLoginEm: null, desativadoEm: null, desativacaoAuditadaEm: null });
      expect(usuario?.["criadoEm"]).toBeInstanceOf(Date);
      expect(usuario?.["atualizadoEm"]).toBeInstanceOf(Date);
      expect(String(usuario?.["senhaHash"])).toStartWith("$argon2id$v=19$m=19456,t=2,");
      expect(String(usuario?.["senhaHash"])).not.toContain(SENHA);
      expect(await valorDaSequencia()).toBe(sequenciaAntes + 1);

      // Nenhuma outra coleção, documento ou índice mudou; nenhuma coleção nova.
      const depois = await fotografia();
      expect(depois.colecoes).toEqual(antes.colecoes);
      expect(depois.indices).toEqual(antes.indices);
      expect({ ...depois.contagens, usuarios: 0, sequencias: 0 }).toEqual({ ...antes.contagens, usuarios: 0, sequencias: 0 });
      expect(depois.contagens["usuarios"]).toBe((antes.contagens["usuarios"] ?? 0) + 1);

      // O hash é o do login: autentica com a senha (e o e-mail em qualquer caixa).
      const sessao = await auth.login({ usuario: email.toUpperCase(), senha: SENHA }, contextoLogin);
      expect(sessao.usuario).toMatchObject({ codigo: codigoEsperado, email, tipo: "ADMIN", ativo: true });
      await auth.logout({ refreshToken: sessao.refreshToken });
    });

    it("usuário existente: dry-run e --apply devolvem 1 e nada muda (nem a sequência)", async () => {
      const email = emailUnico("existente");
      expect((await executar(ARGS_APPLY, variaveisDeCriacao(email), abrirContextoDoComando)).codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      const documento = await connection.collection("usuarios").findOne({ email });
      const sequencia = await valorDaSequencia();

      const previsao = await executar(ARGS_DRY_RUN, variaveisDeCriacao(email), abrirContextoDoComando);
      expect(previsao.codigo).toBe(CODIGOS_DE_SAIDA.jaExiste);
      expect(previsao.texto).toContain("já existe um usuário com este e-mail");

      const repeticao = await executar(ARGS_APPLY, variaveisDeCriacao(email, { ADMIN_NAME: "Outro Nome", ADMIN_PASSWORD: "outra-senha-123" }), abrirContextoDoComando);
      expect(repeticao.codigo).toBe(CODIGOS_DE_SAIDA.jaExiste);
      expect(repeticao.texto).toContain("Já existe um usuário com este e-mail");
      expect(await connection.collection("usuarios").findOne({ email })).toEqual(documento);
      expect(await valorDaSequencia()).toBe(sequencia);
    });

    it("o AuthService.criarAdminSeed (usado pelos testes e pelo login) segue o mesmo contrato via o serviço extraído", async () => {
      const email = emailUnico("delegacao");
      const primeiro = await auth.criarAdminSeed({ nome: ` ${NOME} `, email: email.toUpperCase(), senha: SENHA });
      expect(primeiro).toMatchObject({ criado: true, usuario: { email, nome: NOME, tipo: "ADMIN", ativo: true } });
      expect(await auth.criarAdminSeed({ nome: NOME, email, senha: SENHA })).toMatchObject({ criado: false, usuario: { id: primeiro.usuario.id } });
    });
  });
});
