import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { fileURLToPath } from "node:url";
import type { Connection } from "mongoose";
import { AppModule } from "../app.module.js";
import { ApiException } from "../common/exceptions/api.exception.js";
import { AuthService } from "../modules/auth/auth.service.js";
import { FalhaRedefinicaoSenhaAdmin } from "../modules/auth/redefinicao-senha-admin.service.js";
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
  type ContextoRedefinicao,
} from "./reset-admin-password.comando.js";

/**
 * Comando `admin:reset-password` em contexto mínimo, com as guardas de `seed:admin`/`admin:desativar`.
 *
 * - Recusas: um abridor que só REGISTRA a chamada e se recusa a conectar prova que toda recusa acontece antes de
 *   qualquer conexão. Nenhum teste conecta a um banco que não seja `mariela_test` local.
 * - Integração: o contexto REAL do comando contra `mariela_test`, instrumentado para provar que o dry-run só lê e que o
 *   `--apply` só escreve a senha, a revogação das sessões e o evento. O `AppModule` é só do PRÓPRIO teste (login e
 *   conferências), nunca do comando.
 */

const BANCO_DE_TESTE = "mariela_test";
const URI_PRODUCAO = "mongodb+srv://usuario_app:SenhaSecretaDoAtlas123@cluster0.exemplo.mongodb.net/marielaDB?retryWrites=true&w=majority";
const SENHA_ANTIGA = "senha-antiga-reset-7h2q";
const SENHA_NOVA = "senha-nova-reset-4m8x"; // nunca pode aparecer em nenhuma saída
const PREFIXO_EMAIL = "teste.reset-cmd.";
const contextoLogin = { ip: "127.0.0.1", userAgent: "bun-test-reset" };

const EXECUCAO_LOCAL: AmbienteDeExecucao = {
  arquivoDeEntrada: fileURLToPath(new URL("./reset-admin-password.ts", import.meta.url)),
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

function variaveisDeReset(email: string, extras: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { MONGODB_URI: MONGODB_URI_TESTE, ADMIN_EMAIL: email, ADMIN_PASSWORD: SENHA_NOVA, ADMIN_RESET_CONFIRM: email, ...extras };
}

async function executar(argv: string[], variaveis: Record<string, string | undefined>, abrir: AbrirContexto, execucao: AmbienteDeExecucao = EXECUCAO_LOCAL) {
  const saida: string[] = [];
  const codigo = await executarComando({ argv, variaveis, escrever: (linha) => saida.push(linha), abrirContexto: abrir, execucao });
  const texto = saida.join("\n");
  expect(texto).not.toContain(SENHA_NOVA);
  expect(texto).not.toContain("$argon2");
  return { codigo, texto };
}

const ARGS_DRY_RUN = ["--banco", BANCO_DE_TESTE];
const ARGS_APPLY = ["--banco", BANCO_DE_TESTE, "--apply"];

const COMANDOS_DE_ESTRUTURA = ["createIndexes", "dropIndexes", "listIndexes", "create", "drop", "dropDatabase", "collMod", "renameCollection"];
const COMANDOS_DE_ESCRITA = ["insert", "update", "delete", "findAndModify", "bulkWrite"];
const COMANDOS_DE_LEITURA_ACEITOS = new Set(["find", "getMore", "killCursors", "aggregate", "count", "distinct", "endSessions"]);
const METODOS_MONGOOSE_DE_ESTRUTURA = ["createIndex", "createIndexes", "ensureIndexes", "syncIndexes", "dropIndex", "dropIndexes", "createCollection"];

function instrumentado() {
  const comandos: { nome: string; colecao: unknown }[] = [];
  const metodos: string[] = [];
  let comandosAteContextoPronto: number | null = null;
  const abrir = criarAbridorDeContexto({
    aoConectar: (conexao) => {
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
  return { abrir, comandos, metodos, inicializacao: () => comandos.slice(0, comandosAteContextoPronto ?? 0) };
}

describe("comando admin:reset-password em contexto mínimo", () => {
  it("pré-condição: os testes de integração usam exclusivamente mariela_test em host local", () => {
    expect(analisarUri(MONGODB_URI_TESTE)).toEqual({ banco: BANCO_DE_TESTE, local: true });
  });

  describe("recusas ANTES de qualquer conexão", () => {
    const email = "admin.reset@mariela.dev";

    it("execução fora do código-fonte ou em ambiente implantado é recusada (dist, NODE_ENV, Render, Docker)", async () => {
      const cenarios: AmbienteDeExecucao[] = [
        { ...EXECUCAO_LOCAL, arquivoDeEntrada: "C:\\app\\dist\\scripts\\reset-admin-password.js" },
        { ...EXECUCAO_LOCAL, variaveis: { NODE_ENV: "production" } },
        { ...EXECUCAO_LOCAL, variaveis: { RENDER_SERVICE_ID: "srv-x" } },
        { ...EXECUCAO_LOCAL, existeArquivo: (caminho: string) => caminho === "/.dockerenv" },
      ];
      for (const execucao of cenarios) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeReset(email), abridor.abrir, execucao);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain("Nenhuma conexão foi aberta");
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("a invocação antiga (sem --banco) é recusada com o uso; parâmetros desconhecidos, repetidos ou sem --apply também", async () => {
      for (const argv of [[], ["--apply"], ["--banco", BANCO_DE_TESTE, "--forcar"], ["--banco", "a", "--banco", "b"], ["--banco", BANCO_DE_TESTE, "--confirmar-producao", BANCO_DE_TESTE]]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(argv, variaveisDeReset(email), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(abridor.chamadas).toEqual([]);
        if (argv.length === 0) expect(texto).toContain("Uso: bun run admin:reset-password --banco");
      }
    });

    it("e-mail ausente ou inválido e executor longo são recusados (inclusive no dry-run)", async () => {
      const casos: Record<string, string | undefined>[] = [
        { ADMIN_EMAIL: undefined },
        { ADMIN_EMAIL: "sem-arroba" },
        { ADMIN_EMAIL: "com espaco@x.y" },
        { ADMIN_RESET_EXECUTOR: "x".repeat(LIMITES.executorMaximo + 1) },
      ];
      for (const extras of casos) {
        const abridor = abridorQueNaoConecta();
        const { codigo } = await executar(ARGS_DRY_RUN, variaveisDeReset(email, extras), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("senha: ausente no --apply, menor que 8 ou maior que 200 é recusada, sem ecoar o valor; 8 e 200 são aceitas", async () => {
      for (const senha of [undefined, "", "curta77", "x".repeat(LIMITES.senhaMaxima + 1)]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeReset(email, { ADMIN_PASSWORD: senha }), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain("ADMIN_PASSWORD");
        if (senha) expect(texto).not.toContain(senha);
        expect(abridor.chamadas).toEqual([]);
      }
      expect(interpretarVariaveis(variaveisDeReset(email, { ADMIN_PASSWORD: "x".repeat(LIMITES.senhaMinima) }), true).ok).toBe(true);
      expect(interpretarVariaveis(variaveisDeReset(email, { ADMIN_PASSWORD: "x".repeat(LIMITES.senhaMaxima) }), true).ok).toBe(true);
      // No dry-run a senha é opcional, mas se vier é validada.
      expect(interpretarVariaveis(variaveisDeReset(email, { ADMIN_PASSWORD: undefined }), false).ok).toBe(true);
      expect(interpretarVariaveis(variaveisDeReset(email, { ADMIN_PASSWORD: "curta77" }), false).ok).toBe(false);
    });

    it("--apply exige ADMIN_RESET_CONFIRM com o MESMO e-mail", async () => {
      for (const confirmacao of [undefined, "", "outro@mariela.dev", "sim"]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeReset(email, { ADMIN_RESET_CONFIRM: confirmacao }), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain("ADMIN_RESET_CONFIRM");
        expect(abridor.chamadas).toEqual([]);
      }
      expect(interpretarVariaveis(variaveisDeReset(email, { ADMIN_RESET_CONFIRM: ` ${email.toUpperCase()} ` }), true).ok).toBe(true);
      // O dry-run não exige a confirmação.
      expect(interpretarVariaveis(variaveisDeReset(email, { ADMIN_RESET_CONFIRM: undefined }), false).ok).toBe(true);
    });

    it("banco: URI ausente, banco divergente da URI e mariela_dev_local são recusados", async () => {
      const casos: { argv: string[]; uri: string | undefined }[] = [
        { argv: ARGS_DRY_RUN, uri: undefined },
        { argv: ["--banco", "outro_banco"], uri: MONGODB_URI_TESTE },
        { argv: ["--banco", "outro_banco", "--apply"], uri: MONGODB_URI_TESTE },
        { argv: ["--banco", "mariela_dev_local"], uri: "mongodb://127.0.0.1:27017/mariela_dev_local" },
        { argv: ARGS_DRY_RUN, uri: "mongodb://127.0.0.1:27017/mariela_dev_local" },
      ];
      for (const caso of casos) {
        const abridor = abridorQueNaoConecta();
        const { codigo } = await executar(caso.argv, variaveisDeReset(email, { MONGODB_URI: caso.uri }), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("produção: --apply sem a confirmação exata é recusado; só a combinação exata autoriza; URI e senha nunca aparecem", async () => {
      const variaveis = variaveisDeReset(email, { MONGODB_URI: URI_PRODUCAO });
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

    it("`bun run admin:reset-password` NÃO carrega o .env (--no-env-file): sem variáveis no processo, recusa antes de conectar", async () => {
      const ambiente: Record<string, string> = {};
      for (const [nome, valor] of Object.entries(process.env)) {
        if (valor !== undefined && !nome.startsWith("ADMIN_") && nome !== "MONGODB_URI") ambiente[nome] = valor;
      }
      const processo = Bun.spawn(["bun", "run", "admin:reset-password", "--banco", BANCO_DE_TESTE], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: ambiente,
        stdout: "pipe",
        stderr: "pipe",
      });
      const saida = await new Response(processo.stdout).text();
      expect(await processo.exited).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(saida).toContain("Defina ADMIN_EMAIL");
    });

    it("falha no meio da redefinição: diz até onde chegou e sai com 3, sem senha nem URI", async () => {
      const casos = [
        { etapa: "senha", esperado: "Nada foi alterado" },
        { etapa: "revogacao", esperado: "A senha nova JÁ está gravada, mas a revogação das sessões falhou" },
        { etapa: "auditoria", esperado: "evento ADMIN_PASSWORD_RESET não foi gravado" },
      ] as const;
      for (const caso of casos) {
        const contexto: ContextoRedefinicao = {
          service: {
            avaliar: async () => ({ status: "nao_encontrado" }),
            redefinir: async () => {
              throw new FalhaRedefinicaoSenhaAdmin(caso.etapa, new Error(`falhou em ${MONGODB_URI_TESTE}`));
            },
          },
          conexao: { name: BANCO_DE_TESTE } as Connection,
          fechar: async () => undefined,
        };
        const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeReset(email), async () => contexto);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.falha);
        expect(texto).toContain(`ERRO na etapa "${caso.etapa}"`);
        expect(texto).toContain(caso.esperado);
        expect(texto).not.toContain(MONGODB_URI_TESTE);
      }
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
      await Promise.all(Object.values(connection.models).map((model) => model.init()));
    });

    afterAll(async () => {
      const criados = await connection.collection("usuarios").find({ email: { $regex: `^${PREFIXO_EMAIL.replaceAll(".", "\\.")}` } }).toArray();
      const ids = criados.map((usuario) => usuario["_id"]);
      await connection.collection("eventos_auth").deleteMany({ usuarioId: { $in: ids } });
      await connection.collection("refresh_tokens").deleteMany({ usuarioId: { $in: ids } });
      await connection.collection("usuarios").deleteMany({ _id: { $in: ids } });
      await moduleRef.close();
    });

    async function criarAdminComSessao(sufixo: string) {
      const email = emailUnico(sufixo);
      const { usuario } = await auth.criarAdminSeed({ nome: `Reset ${sufixo}`, email, senha: SENHA_ANTIGA });
      const sessao = await auth.login({ usuario: email, senha: SENHA_ANTIGA }, contextoLogin);
      const documento = await connection.collection("usuarios").findOne({ email });
      return { email, usuario, sessao, documento: documento! };
    }

    const sessoesValidas = async (usuarioId: unknown) => connection.collection("refresh_tokens").countDocuments({ usuarioId, revogadoEm: null, expiresAt: { $gt: new Date() } });
    const eventosReset = async (usuarioId: unknown) => connection.collection("eventos_auth").find({ usuarioId, tipo: "ADMIN_PASSWORD_RESET" }).toArray();

    it("dry-run: só leituras (nem na inicialização); mostra alvo e sessões; senha, sessões e eventos ficam intactos", async () => {
      const { email, sessao, documento } = await criarAdminComSessao("dry-run");
      const instr = instrumentado();

      const { codigo, texto } = await executar(ARGS_DRY_RUN, variaveisDeReset(email, { ADMIN_RESET_CONFIRM: undefined }), instr.abrir);

      expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(texto).toContain(`Alvo: ${documento["codigo"]} <${email}> — ativo: true; sessões válidas: 1`);
      expect(texto).toContain("[PREVISÃO] o --apply gravaria a nova senha, revogaria 1 sessão(ões)");
      expect(texto).toContain("Dry-run: nada foi alterado.");
      expect(instr.inicializacao()).toEqual([]);
      expect(instr.comandos.map((comando) => comando.nome).filter((nome) => !COMANDOS_DE_LEITURA_ACEITOS.has(nome))).toEqual([]);
      expect(instr.metodos.filter((metodo) => METODOS_MONGOOSE_DE_ESTRUTURA.includes(metodo))).toEqual([]);

      expect(await connection.collection("usuarios").findOne({ email })).toEqual(documento);
      expect(await sessoesValidas(documento["_id"])).toBe(1);
      expect(await eventosReset(documento["_id"])).toEqual([]);
      expect((await auth.refresh({ refreshToken: sessao.refreshToken }, contextoLogin)).accessToken).toBeTruthy();
    });

    it("--apply: troca só a senha, revoga TODAS as sessões, grava ADMIN_PASSWORD_RESET; escreve só usuário, sessões e evento", async () => {
      const { email, sessao } = await criarAdminComSessao("apply");
      const segunda = await auth.login({ usuario: email, senha: SENHA_ANTIGA }, contextoLogin);
      // Fotografia DEPOIS do segundo login (que atualiza `ultimoLoginEm`).
      const documento = (await connection.collection("usuarios").findOne({ email }))!;
      const instr = instrumentado();

      const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeReset(email.toUpperCase(), { ADMIN_RESET_EXECUTOR: " Dev Responsável " }), instr.abrir);

      expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(texto).toContain(`[RESULTADO] senha de ${documento["codigo"]} <${email}> redefinida.`);
      expect(texto).toContain("Sessões revogadas nesta execução: 2");
      expect(texto).toContain("Sessões ainda válidas depois da revogação: 0");
      expect(texto).toContain("Auditoria: ADMIN_PASSWORD_RESET registrado");

      // Comandos: nenhum de estrutura; escritas = senha (update usuarios), revogação (update refresh_tokens), evento.
      expect(instr.inicializacao()).toEqual([]);
      expect(instr.comandos.filter((comando) => COMANDOS_DE_ESTRUTURA.includes(comando.nome))).toEqual([]);
      expect(instr.comandos.filter((comando) => COMANDOS_DE_ESCRITA.includes(comando.nome))).toEqual([
        { nome: "update", colecao: "usuarios" },
        { nome: "update", colecao: "refresh_tokens" },
        { nome: "insert", colecao: "eventos_auth" },
      ]);
      expect(instr.metodos.filter((metodo) => METODOS_MONGOOSE_DE_ESTRUTURA.includes(metodo))).toEqual([]);

      // Só `senhaHash` (e o carimbo de atualização) mudou.
      const depois = await connection.collection("usuarios").findOne({ email });
      expect(String(depois!["senhaHash"])).toStartWith("$argon2id$v=19$m=19456,t=2,");
      expect(depois!["senhaHash"]).not.toBe(documento["senhaHash"]);
      const { senhaHash: _h1, atualizadoEm: _a1, ...restoDepois } = depois!;
      const { senhaHash: _h2, atualizadoEm: _a2, ...restoAntes } = documento;
      expect(restoDepois).toEqual(restoAntes);

      // Sessões anteriores: nenhuma válida, nenhuma renova.
      expect(await sessoesValidas(documento["_id"])).toBe(0);
      await expect(auth.refresh({ refreshToken: sessao.refreshToken }, contextoLogin)).rejects.toThrow(ApiException);
      await expect(auth.refresh({ refreshToken: segunda.refreshToken }, contextoLogin)).rejects.toThrow(ApiException);

      // Login: a antiga falha, a nova funciona.
      await expect(auth.login({ usuario: email, senha: SENHA_ANTIGA }, contextoLogin)).rejects.toThrow(ApiException);
      expect((await auth.login({ usuario: email, senha: SENHA_NOVA }, contextoLogin)).usuario.email).toBe(email);

      // Auditoria: um evento, com executor e origem, sem senha, hash ou token.
      const eventos = await eventosReset(documento["_id"]);
      expect(eventos).toHaveLength(1);
      expect(eventos[0]).toMatchObject({ origem: "comando:admin:reset-password", executor: "Dev Responsável", sessoesRevogadas: 2, ip: null, userAgent: null });
      const serializado = JSON.stringify(eventos);
      for (const segredo of [SENHA_NOVA, SENHA_ANTIGA, String(depois!["senhaHash"]), sessao.refreshToken, sessao.accessToken]) {
        expect(serializado).not.toContain(segredo);
      }
    });

    it("repetir o --apply é seguro: mesmo estado final, cada execução efetiva auditada", async () => {
      const { email, documento } = await criarAdminComSessao("repeticao");
      expect((await executar(ARGS_APPLY, variaveisDeReset(email), abrirContextoDoComando)).codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      const segunda = await executar(ARGS_APPLY, variaveisDeReset(email), abrirContextoDoComando);
      expect(segunda.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(segunda.texto).toContain("Sessões revogadas nesta execução: 0");
      expect(await sessoesValidas(documento["_id"])).toBe(0);
      expect((await eventosReset(documento["_id"])).map((evento) => evento["sessoesRevogadas"])).toEqual([1, 0]);
      expect((await auth.login({ usuario: email, senha: SENHA_NOVA }, contextoLogin)).usuario.email).toBe(email);
    });

    it("e-mail inexistente ou usuário não ADMIN: dry-run e --apply devolvem 1 e nada muda", async () => {
      const inexistente = emailUnico("inexistente");
      for (const argv of [ARGS_DRY_RUN, ARGS_APPLY]) {
        const { codigo, texto } = await executar(argv, variaveisDeReset(inexistente), abrirContextoDoComando);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.alvoRecusado);
        expect(texto).toContain("nenhum usuário com o e-mail");
      }
      expect(await connection.collection("usuarios").findOne({ email: inexistente })).toBeNull();

      const { email, documento } = await criarAdminComSessao("nao-admin");
      // Role fora de ROLES não é alcançável pelo código real — gravado direto só para o cenário defensivo.
      await connection.collection("usuarios").updateOne({ email }, { $set: { role: "NAO_ADMIN" } });
      const antes = await connection.collection("usuarios").findOne({ email });
      for (const argv of [ARGS_DRY_RUN, ARGS_APPLY]) {
        const { codigo, texto } = await executar(argv, variaveisDeReset(email), abrirContextoDoComando);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.alvoRecusado);
        expect(texto).toContain("não é ADMIN");
      }
      expect(await connection.collection("usuarios").findOne({ email })).toEqual(antes);
      expect(await sessoesValidas(documento["_id"])).toBe(1);
      expect(await eventosReset(documento["_id"])).toEqual([]);
    });

    it("ADMIN inativo: o comando avisa que a senha nova não permite login enquanto ele estiver desativado", async () => {
      const { email } = await criarAdminComSessao("inativo");
      await connection.collection("usuarios").updateOne({ email }, { $set: { ativo: false } });
      const previsao = await executar(ARGS_DRY_RUN, variaveisDeReset(email), abrirContextoDoComando);
      expect(previsao.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(previsao.texto).toContain("ativo: false");
      expect(previsao.texto).toContain("o usuário está INATIVO");
      const aplicado = await executar(ARGS_APPLY, variaveisDeReset(email), abrirContextoDoComando);
      expect(aplicado.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(aplicado.texto).toContain("o usuário está INATIVO");
      await expect(auth.login({ usuario: email, senha: SENHA_NOVA }, contextoLogin)).rejects.toThrow(ApiException);
    });
  });
});
