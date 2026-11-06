import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { fileURLToPath } from "node:url";
import { Types, type Connection } from "mongoose";
import { AppModule } from "../app.module.js";
import { ApiException } from "../common/exceptions/api.exception.js";
import { AuthService } from "../modules/auth/auth.service.js";
import { RefreshTokensRepository } from "../modules/auth/refresh-tokens.repository.js";
import { MONGODB_URI_TESTE } from "../test-utils/mongo-teste.util.js";
import { analisarUri, type AmbienteDeExecucao } from "./comando-local.util.js";
import {
  abrirContextoDoComando,
  CODIGOS_DE_SAIDA,
  criarAbridorDeContexto,
  executarComando,
  interpretarVariaveis,
  LIMITES,
  validarAmbiente,
  type AbrirContexto,
} from "./desativar-admin.comando.js";

/**
 * Fase 60.4.3.1.5 — comando `admin:desativar`.
 *
 * - Recusas: `executarComando` com um abridor que só REGISTRA a chamada e se recusa a conectar — prova que toda
 *   recusa acontece antes de qualquer conexão. Nenhum teste conecta a um banco que não seja `mariela_test` local.
 * - Integração: o contexto REAL do comando (`ComandoDesativarAdminModule`) contra `mariela_test`, com a conexão
 *   instrumentada (driver e Mongoose) para provar que o dry-run não escreve nada.
 */

const BANCO_DE_TESTE = "mariela_test";
const URI_PRODUCAO = "mongodb+srv://usuario_app:SenhaSecretaDoAtlas123@cluster0.exemplo.mongodb.net/marielaDB?retryWrites=true&w=majority";
const SENHA = "senha-correta-123";
const PREFIXO_EMAIL = "teste.cmd-desativar.";
const MOTIVO = "Encerramento da conta temporária de testes";
const contexto = { ip: "127.0.0.1", userAgent: "bun-test-cmd-desativar" };

const EXECUCAO_LOCAL: AmbienteDeExecucao = {
  arquivoDeEntrada: fileURLToPath(new URL("./desativar-admin.ts", import.meta.url)),
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

function variaveisDeAplicacao(email: string, extras: Record<string, string> = {}): Record<string, string> {
  return { MONGODB_URI: MONGODB_URI_TESTE, ADMIN_EMAIL: email, ADMIN_DEACTIVATE_CONFIRM: email, ADMIN_DEACTIVATE_REASON: MOTIVO, ...extras };
}

async function executar(argv: string[], variaveis: Record<string, string | undefined>, abrir: AbrirContexto, execucao: AmbienteDeExecucao = EXECUCAO_LOCAL) {
  const saida: string[] = [];
  const codigo = await executarComando({ argv, variaveis, escrever: (linha) => saida.push(linha), abrirContexto: abrir, execucao });
  return { codigo, texto: saida.join("\n") };
}

const ARGS_DRY_RUN = ["--banco", BANCO_DE_TESTE];
const ARGS_APPLY = ["--banco", BANCO_DE_TESTE, "--apply"];

describe("comando admin:desativar (Fase 60.4.3.1.5)", () => {
  it("pré-condição: os testes de integração usam exclusivamente mariela_test em host local", () => {
    expect(analisarUri(MONGODB_URI_TESTE)).toEqual({ banco: BANCO_DE_TESTE, local: true });
  });

  describe("recusas ANTES de qualquer conexão", () => {
    const email = "alvo@mariela.dev";

    it("execução fora do código-fonte ou em ambiente implantado é recusada (dist, NODE_ENV, Render, Docker)", async () => {
      const cenarios: AmbienteDeExecucao[] = [
        { ...EXECUCAO_LOCAL, arquivoDeEntrada: "C:\\app\\dist\\scripts\\desativar-admin.js" },
        { ...EXECUCAO_LOCAL, variaveis: { NODE_ENV: "production" } },
        { ...EXECUCAO_LOCAL, variaveis: { RENDER: "true", RENDER_SERVICE_ID: "srv-x" } },
        { ...EXECUCAO_LOCAL, existeArquivo: (caminho) => caminho === "/.dockerenv" },
      ];
      for (const execucao of cenarios) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeAplicacao(email), abridor.abrir, execucao);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain("Nenhuma conexão foi aberta");
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("argumentos inválidos: --banco ausente/inválido, parâmetro desconhecido ou repetido, --confirmar-producao sem --apply", async () => {
      for (const argv of [[], ["--banco"], ["--banco", "nome inválido!"], ["--banco", BANCO_DE_TESTE, "--forcar"], ["--banco", "a", "--banco", "b"], ["--banco", BANCO_DE_TESTE, "--confirmar-producao", BANCO_DE_TESTE], [MONGODB_URI_TESTE]]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(argv, variaveisDeAplicacao(email), abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).not.toContain("mongodb://");
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("ADMIN_EMAIL ausente ou malformado é recusado (inclusive no dry-run)", async () => {
      for (const valor of [undefined, "", "   ", "sem-arroba", "dois@@x", "com espaco@x.y"]) {
        const abridor = abridorQueNaoConecta();
        const { codigo } = await executar(ARGS_DRY_RUN, { MONGODB_URI: MONGODB_URI_TESTE, ADMIN_EMAIL: valor }, abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("--apply exige confirmação explícita (o MESMO e-mail) e motivo; executor longo é recusado", async () => {
      const casos: { variaveis: Record<string, string | undefined>; trecho: string }[] = [
        { variaveis: variaveisDeAplicacao(email, { ADMIN_DEACTIVATE_CONFIRM: "" }), trecho: "ADMIN_DEACTIVATE_CONFIRM" },
        { variaveis: { MONGODB_URI: MONGODB_URI_TESTE, ADMIN_EMAIL: email, ADMIN_DEACTIVATE_REASON: MOTIVO }, trecho: "ADMIN_DEACTIVATE_CONFIRM" },
        { variaveis: variaveisDeAplicacao(email, { ADMIN_DEACTIVATE_CONFIRM: "outro@mariela.dev" }), trecho: "não corresponde" },
        { variaveis: variaveisDeAplicacao(email, { ADMIN_DEACTIVATE_CONFIRM: "sim" }), trecho: "não corresponde" },
        { variaveis: variaveisDeAplicacao(email, { ADMIN_DEACTIVATE_REASON: "" }), trecho: "ADMIN_DEACTIVATE_REASON" },
        { variaveis: variaveisDeAplicacao(email, { ADMIN_DEACTIVATE_REASON: "ab" }), trecho: "ADMIN_DEACTIVATE_REASON" },
        { variaveis: variaveisDeAplicacao(email, { ADMIN_DEACTIVATE_REASON: "x".repeat(LIMITES.motivoMaximo + 1) }), trecho: "ADMIN_DEACTIVATE_REASON" },
        { variaveis: variaveisDeAplicacao(email, { ADMIN_DEACTIVATE_EXECUTOR: "x".repeat(LIMITES.executorMaximo + 1) }), trecho: "ADMIN_DEACTIVATE_EXECUTOR" },
      ];
      for (const caso of casos) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(ARGS_APPLY, caso.variaveis, abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain(caso.trecho);
        expect(abridor.chamadas).toEqual([]);
      }
      // A confirmação passa pela MESMA normalização do e-mail (maiúsculas/espaços).
      expect(interpretarVariaveis(variaveisDeAplicacao(email, { ADMIN_DEACTIVATE_CONFIRM: `  ${email.toUpperCase()} ` }), true).ok).toBe(true);
    });

    it("banco: URI ausente, banco divergente e mariela_dev_local são recusados", async () => {
      const casos: { argv: string[]; uri: string | undefined }[] = [
        { argv: ARGS_DRY_RUN, uri: undefined },
        { argv: ["--banco", "outro_banco"], uri: MONGODB_URI_TESTE },
        { argv: ["--banco", "mariela_dev_local"], uri: "mongodb://127.0.0.1:27017/mariela_dev_local" },
        { argv: ARGS_DRY_RUN, uri: "mongodb://127.0.0.1:27017/mariela_dev_local" },
      ];
      for (const caso of casos) {
        const abridor = abridorQueNaoConecta();
        const { codigo } = await executar(caso.argv, { ...variaveisDeAplicacao(email), MONGODB_URI: caso.uri }, abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("produção: --apply sozinho ou com confirmação errada é recusado; nunca seleciona marielaDB sozinho; URI e senha nunca aparecem", async () => {
      const variaveis = { ...variaveisDeAplicacao(email), MONGODB_URI: URI_PRODUCAO };
      for (const argv of [["--banco", "marielaDB", "--apply"], ["--banco", "marielaDB", "--apply", "--confirmar-producao", "marieladb"], ["--banco", "mariela_test", "--apply"]]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar(argv, variaveis, abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).not.toContain("SenhaSecretaDoAtlas123");
        expect(texto).not.toContain("mongodb+srv://");
        expect(abridor.chamadas).toEqual([]);
      }
      // Só a combinação exata autoriza (aqui o abridor se recusa a conectar: a falha vem DEPOIS da autorização).
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar(["--banco", "marielaDB", "--apply", "--confirmar-producao", "marielaDB"], variaveis, abridor.abrir);
      expect(abridor.chamadas).toEqual([URI_PRODUCAO]);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.falha);
      expect(texto).toContain("PROTEGIDO");
      expect(texto).not.toContain("SenhaSecretaDoAtlas123");
      // Em banco de teste local, --confirmar-producao não se aplica.
      expect(validarAmbiente({ banco: BANCO_DE_TESTE, aplicar: true, confirmacaoProducao: BANCO_DE_TESTE }, MONGODB_URI_TESTE).ok).toBe(false);
    });
  });

  describe("integração com mariela_test (contexto real do comando)", () => {
    let moduleRef: TestingModule;
    let auth: AuthService;
    let connection: Connection;

    beforeAll(async () => {
      process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      auth = moduleRef.get(AuthService);
      connection = moduleRef.get(getConnectionToken());
    });

    afterAll(async () => {
      const meus = await connection.collection("usuarios").find({ email: { $regex: `^${PREFIXO_EMAIL.replaceAll(".", "\\.")}` } }).toArray();
      const ids = meus.map((usuario) => usuario["_id"]);
      await connection.collection("refresh_tokens").deleteMany({ usuarioId: { $in: ids } });
      await connection.collection("eventos_auth").deleteMany({ usuarioId: { $in: ids } });
      await connection.collection("usuarios").deleteMany({ _id: { $in: ids } });
      await moduleRef.close();
    });

    async function criarAdminComSessoes(sufixo: string, sessoes: number) {
      const email = emailUnico(sufixo);
      const { usuario } = await auth.criarAdminSeed({ nome: `Comando ${sufixo}`, email, senha: SENHA });
      const emitidas: Awaited<ReturnType<AuthService["login"]>>[] = [];
      for (let indice = 0; indice < sessoes; indice += 1) emitidas.push(await auth.login({ usuario: email, senha: SENHA }, contexto));
      return { email, objectId: new Types.ObjectId(usuario.id), sessoes: emitidas };
    }

    const sessoesAtivas = (usuarioId: Types.ObjectId) => connection.collection("refresh_tokens").countDocuments({ usuarioId, revogadoEm: null });

    const COMANDOS_DE_ESCRITA = ["insert", "update", "delete", "findAndModify", "createIndexes", "dropIndexes", "create", "drop", "collMod", "bulkWrite"];
    const COMANDOS_DE_LEITURA_ACEITOS = new Set(["find", "getMore", "killCursors", "aggregate", "count", "distinct", "endSessions"]);

    function instrumentado() {
      const comandos: string[] = [];
      const conexoes: Connection[] = [];
      const abrir = criarAbridorDeContexto({
        aoConectar: (conexao) => {
          conexoes.push(conexao);
          conexao.getClient().on("commandStarted", (evento: { commandName: string }) => comandos.push(evento.commandName));
        },
      });
      return { abrir, comandos, conexoes };
    }

    it("dry-run: relata o alvo e a previsão sem NENHUM comando de escrita ou de índice; conexão encerrada", async () => {
      const alvo = await criarAdminComSessoes("dry-run", 2);
      const antes = await connection.collection("usuarios").findOne({ email: alvo.email });
      const { abrir, comandos, conexoes } = instrumentado();

      const { codigo, texto } = await executar(ARGS_DRY_RUN, { MONGODB_URI: MONGODB_URI_TESTE, ADMIN_EMAIL: alvo.email }, abrir);

      expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(texto).toContain("Modo: dry-run");
      expect(texto).toContain("estado atual: ativo; sessões válidas: 2");
      expect(texto).toContain("Dry-run: nada foi alterado.");
      expect(comandos).toContain("find");
      expect(comandos.filter((nome) => COMANDOS_DE_ESCRITA.includes(nome))).toEqual([]);
      expect(comandos.filter((nome) => !COMANDOS_DE_LEITURA_ACEITOS.has(nome))).toEqual([]);
      expect(await connection.collection("usuarios").findOne({ email: alvo.email })).toEqual(antes);
      expect(await sessoesAtivas(alvo.objectId)).toBe(2);
      expect(conexoes.map((conexao) => conexao.readyState)).toEqual([0]);
      expect(texto).not.toContain("mongodb://");
    });

    it("--apply: desativa, revoga todas as sessões e audita; login e refresh recusados; só documentos são escritos (nunca índices)", async () => {
      const alvo = await criarAdminComSessoes("apply", 2);
      const { abrir, comandos } = instrumentado();

      const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeAplicacao(alvo.email, { ADMIN_DEACTIVATE_EXECUTOR: "operador-de-teste" }), abrir);

      expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(texto).toContain("desativado (ativo=false)");
      expect(texto).toContain("Sessões revogadas nesta execução: 2");
      expect(texto).toContain("Sessões ainda válidas depois da revogação: 0");
      expect(texto).toContain("ADMIN_DEACTIVATED registrado");
      expect(comandos.filter((nome) => ["createIndexes", "dropIndexes", "create", "drop", "collMod"].includes(nome))).toEqual([]);
      expect((await connection.collection("usuarios").findOne({ email: alvo.email }))?.["ativo"]).toBe(false);
      expect(await sessoesAtivas(alvo.objectId)).toBe(0);
      expect(await connection.collection("eventos_auth").countDocuments({ usuarioId: alvo.objectId, tipo: "ADMIN_DEACTIVATED", executor: "operador-de-teste", motivo: MOTIVO })).toBe(1);
      await expect(auth.login({ usuario: alvo.email, senha: SENHA }, contexto)).rejects.toThrow(ApiException);
      for (const sessao of alvo.sessoes) await expect(auth.refresh({ refreshToken: sessao.refreshToken }, contexto)).rejects.toThrow(ApiException);
      for (const sessao of alvo.sessoes) expect(texto).not.toContain(sessao.refreshToken);

      // Reexecução idempotente.
      const segunda = await executar(ARGS_APPLY, variaveisDeAplicacao(alvo.email), abrirContextoDoComando);
      expect(segunda.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(segunda.texto).toContain("já estava inativo");
      expect(segunda.texto).toContain("não duplicado");
      expect(await connection.collection("eventos_auth").countDocuments({ usuarioId: alvo.objectId, tipo: "ADMIN_DEACTIVATED" })).toBe(1);
    });

    it("alvo inexistente: código 1, nada criado", async () => {
      const email = emailUnico("inexistente");
      for (const argv of [ARGS_DRY_RUN, ARGS_APPLY]) {
        const { codigo, texto } = await executar(argv, variaveisDeAplicacao(email), abrirContextoDoComando);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.alvoRecusado);
        expect(texto).toContain("nenhum usuário com o e-mail");
      }
      expect(await connection.collection("usuarios").countDocuments({ email })).toBe(0);
    });

    it("alvo não ADMIN: código 1, documento intacto", async () => {
      const email = emailUnico("nao-admin");
      await connection.collection("usuarios").insertOne({ codigo: `USR-C${Date.now()}`, nome: "Não admin", email, senhaHash: "x", role: "OPERADOR", ativo: true });
      const antes = await connection.collection("usuarios").findOne({ email });
      const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeAplicacao(email), abrirContextoDoComando);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.alvoRecusado);
      expect(texto).toContain("não é ADMIN");
      expect(await connection.collection("usuarios").findOne({ email })).toEqual(antes);
    });

    it("falha de persistência na revogação: código 3, etapa e estado relatados, sem URI; a reexecução conclui", async () => {
      const alvo = await criarAdminComSessoes("falha", 1);
      const abrir = criarAbridorDeContexto({
        aoCriar: (app) => {
          spyOn(app.get(RefreshTokensRepository), "revogarTodosDoUsuario").mockImplementation(async () => {
            throw new Error(`falha simulada (${MONGODB_URI_TESTE})`);
          });
        },
      });

      const { codigo, texto } = await executar(ARGS_APPLY, variaveisDeAplicacao(alvo.email), abrir);

      expect(codigo).toBe(CODIGOS_DE_SAIDA.falha);
      expect(texto).toContain('ERRO na etapa "revogacao"');
      expect(texto).toContain("JÁ está inativo");
      expect(texto).not.toContain(MONGODB_URI_TESTE);
      expect(await sessoesAtivas(alvo.objectId)).toBe(1);

      const retomada = await executar(ARGS_APPLY, variaveisDeAplicacao(alvo.email), abrirContextoDoComando);
      expect(retomada.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(retomada.texto).toContain("reconciliado");
      expect(await sessoesAtivas(alvo.objectId)).toBe(0);
    });
  });
});
