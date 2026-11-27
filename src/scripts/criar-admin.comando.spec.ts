import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { fileURLToPath } from "node:url";
import type { Connection } from "mongoose";
import { AppModule } from "../app.module.js";
import { AuthService } from "../modules/auth/auth.service.js";
import { FalhaAuditoriaCriacaoAdmin } from "../modules/auth/provisionamento-admin.service.js";
import { MONGODB_URI_TESTE } from "../test-utils/mongo-teste.util.js";
import { analisarUri, type AmbienteDeExecucao } from "./comando-local.util.js";
import {
  CODIGOS_DE_SAIDA,
  executarComando,
  extrairMongodbUriDoEnv,
  resolverUri,
  TENTATIVAS_POR_CAMPO,
  type DependenciasComando,
} from "./criar-admin.comando.js";
import { aplicarTeclas, criarTerminalDoProcesso, type TerminalInterativo } from "./criar-admin.terminal.js";
import { criarAbridorDeContexto, type AbrirContexto, type ContextoSeed } from "./seed-admin.comando.js";

/**
 * Comando interativo `admin:criar`. As respostas vêm de um terminal FALSO (roteiro); a criação real usa o MESMO contexto
 * mínimo do `seed:admin` contra `mariela_test` local. Nenhum teste lê o `.env` real (o leitor é sempre injetado) nem
 * conecta a outro banco.
 */

const BANCO_DE_TESTE = "mariela_test";
const URI_PRODUCAO = "mongodb+srv://usuario_app:SenhaSecretaDoAtlas123@cluster0.exemplo.mongodb.net/marielaDB?retryWrites=true&w=majority";
const SENHA = "senha-interativa-k3v9"; // nunca pode aparecer em nenhuma saída
const NOME = "ADMIN INTERATIVO TESTE";
const PREFIXO_EMAIL = "teste.criar-cmd.";
const contextoLogin = { ip: "127.0.0.1", userAgent: "bun-test-criar" };

const EXECUCAO_LOCAL: AmbienteDeExecucao = {
  arquivoDeEntrada: fileURLToPath(new URL("./criar-admin.ts", import.meta.url)),
  variaveis: {},
  existeArquivo: () => false,
};

let contador = 0;
function emailUnico(sufixo: string): string {
  contador += 1;
  return `${PREFIXO_EMAIL}${sufixo}.${Date.now()}.${contador}@mariela.dev`;
}

/** Terminal falso: cada pergunta consome a próxima resposta do roteiro (`null` = Ctrl+C). */
function terminalComRoteiro(respostas: (string | null)[], interativo = true) {
  const perguntas: { texto: string; oculto: boolean }[] = [];
  const restante = [...respostas];
  const responder = (texto: string, oculto: boolean) => {
    perguntas.push({ texto, oculto });
    if (restante.length === 0) throw new Error(`pergunta sem resposta no roteiro: ${texto}`);
    return Promise.resolve(restante.shift() ?? null);
  };
  const terminal: TerminalInterativo = {
    interativo,
    perguntar: (texto) => responder(texto, false),
    perguntarOculto: (texto) => responder(texto, true),
  };
  return { terminal, perguntas, restante };
}

function abridorQueNaoConecta() {
  const chamadas: string[] = [];
  const abrir: AbrirContexto = async (uri) => {
    chamadas.push(uri);
    throw new Error(`este teste não pode abrir conexão (${uri})`);
  };
  return { abrir, chamadas };
}

/** Roteiro completo até a confirmação final, num banco de teste local. */
function roteiro(email: string, final: string | null = "CRIAR"): (string | null)[] {
  return [email, NOME, SENHA, SENHA, BANCO_DE_TESTE, final];
}

async function executar(
  respostas: (string | null)[],
  abrir: AbrirContexto,
  opcoes: { variaveis?: Record<string, string | undefined>; lerArquivoEnv?: () => string | null; execucao?: AmbienteDeExecucao; interativo?: boolean } = {},
) {
  const { terminal, perguntas, restante } = terminalComRoteiro(respostas, opcoes.interativo ?? true);
  const saida: string[] = [];
  let leuArquivoEnv = false;
  const deps: DependenciasComando = {
    terminal,
    escrever: (linha) => saida.push(linha),
    variaveis: opcoes.variaveis ?? { MONGODB_URI: MONGODB_URI_TESTE },
    lerArquivoEnv: () => {
      leuArquivoEnv = true;
      return opcoes.lerArquivoEnv ? opcoes.lerArquivoEnv() : null;
    },
    abrirContexto: abrir,
    execucao: opcoes.execucao ?? EXECUCAO_LOCAL,
  };
  const codigo = await executarComando(deps);
  const texto = saida.join("\n");
  expect(texto).not.toContain(SENHA);
  expect(texto).not.toContain("$argon2");
  expect(texto).not.toContain("SenhaSecretaDoAtlas123");
  expect(texto).not.toContain("mongodb://");
  expect(texto).not.toContain("mongodb+srv://");
  return { codigo, texto, perguntas, restante, leuArquivoEnv: () => leuArquivoEnv };
}

describe("comando interativo admin:criar", () => {
  it("pré-condição: os testes de integração usam exclusivamente mariela_test em host local", () => {
    expect(analisarUri(MONGODB_URI_TESTE)).toEqual({ banco: BANCO_DE_TESTE, local: true });
  });

  describe("leitura do terminal (teclas em modo raw)", () => {
    const inicio = { valor: "", fim: null } as const;

    it("senha oculta: nada é ecoado — nem caracteres, nem asteriscos, nem o apagar", () => {
      let passo = aplicarTeclas(inicio, "abc", true);
      expect(passo).toEqual({ estado: { valor: "abc", fim: null }, eco: "" });
      passo = aplicarTeclas(passo.estado, "\u007fd\r", true);
      expect(passo).toEqual({ estado: { valor: "abd", fim: "enviar" }, eco: "" });
    });

    it("pergunta visível: ecoa o digitado e o apagar; colar várias teclas e Enter no meio do bloco funcionam", () => {
      const passo = aplicarTeclas(inicio, "ab\bc\r\nignorado", false);
      expect(passo).toEqual({ estado: { valor: "ac", fim: "enviar" }, eco: "ab\b \bc" });
    });

    it("Ctrl+C cancela em qualquer ponto; Ctrl+D só com a linha vazia; setas e teclas de controle são ignoradas", () => {
      expect(aplicarTeclas({ valor: "parcial", fim: null }, "\u0003", true).estado).toEqual({ valor: "", fim: "cancelar" });
      expect(aplicarTeclas(inicio, "\u0004", false).estado.fim).toBe("cancelar");
      expect(aplicarTeclas({ valor: "x", fim: null }, "\u0004", false).estado).toEqual({ valor: "x", fim: null });
      expect(aplicarTeclas({ valor: "x", fim: null }, "\u001b[D", false)).toEqual({ estado: { valor: "x", fim: null }, eco: "" });
      expect(aplicarTeclas(inicio, "a\tb", false).estado.valor).toBe("ab");
    });

    it("terminal real: liga e desliga o modo raw, não escreve a senha na saída e só é interativo com TTY nos dois lados", async () => {
      const escrito: string[] = [];
      const modos: boolean[] = [];
      let ouvinte: ((bloco: string) => void) | null = null;
      const entrada = {
        isTTY: true,
        setRawMode: (ativo: boolean) => modos.push(ativo),
        setEncoding: () => undefined,
        resume: () => undefined,
        pause: () => undefined,
        on: (_evento: "data", fn: (bloco: string) => void) => {
          ouvinte = fn;
        },
        off: () => {
          ouvinte = null;
        },
      };
      const terminal = criarTerminalDoProcesso(entrada, { isTTY: true, write: (texto: string) => escrito.push(texto) });
      expect(terminal.interativo).toBe(true);

      const resposta = terminal.perguntarOculto("Senha: ");
      ouvinte!(SENHA);
      ouvinte!("\r");
      expect(await resposta).toBe(SENHA);
      expect(escrito.join("")).not.toContain(SENHA);
      expect(modos).toEqual([true, false]);
      expect(ouvinte).toBeNull();

      const cancelada = terminal.perguntar("E-mail: ");
      ouvinte!("\u0003");
      expect(await cancelada).toBeNull();

      expect(criarTerminalDoProcesso({ ...entrada, isTTY: false }, { isTTY: true, write: () => undefined }).interativo).toBe(false);
      expect(criarTerminalDoProcesso(entrada, { isTTY: false, write: () => undefined }).interativo).toBe(false);
    });
  });

  describe("configuração do banco (sem exibir a URI)", () => {
    it(".env: extrai SÓ MONGODB_URI (export, aspas, comentário, última ocorrência); interpolação é recusada", () => {
      const conteudo = [
        "ADMIN_PASSWORD=nunca-lida",
        "# MONGODB_URI=comentada",
        "MONGODB_URI=mongodb://127.0.0.1:27017/primeira",
        'export MONGODB_URI="mongodb://127.0.0.1:27017/mariela_test?replicaSet=rs0" # comentário',
        "JWT_ACCESS_SECRET=segredo",
      ].join("\r\n");
      expect(extrairMongodbUriDoEnv(conteudo)).toEqual({ ok: true, valor: "mongodb://127.0.0.1:27017/mariela_test?replicaSet=rs0" });
      expect(extrairMongodbUriDoEnv("MONGODB_URI=mongodb://h/db # nota")).toEqual({ ok: true, valor: "mongodb://h/db" });
      expect(extrairMongodbUriDoEnv("MONGODB_URI='mongodb://h/db'")).toEqual({ ok: true, valor: "mongodb://h/db" });
      expect(extrairMongodbUriDoEnv("OUTRA=1\nADMIN_PASSWORD=x")).toBeNull();
      expect(extrairMongodbUriDoEnv("MONGODB_URI=")).toBeNull();
      const interpolada = extrairMongodbUriDoEnv("MONGODB_URI=mongodb://${HOST}/db");
      expect(interpolada?.ok).toBe(false);
      expect(JSON.stringify(interpolada)).not.toContain("mongodb://");
    });

    it("o ambiente do terminal tem precedência (o .env nem é lido); sem nenhum dos dois, recusa sem exibir nada", () => {
      let leituras = 0;
      const ler = () => {
        leituras += 1;
        return "MONGODB_URI=mongodb://127.0.0.1/do_arquivo";
      };
      expect(resolverUri({ MONGODB_URI: " mongodb://127.0.0.1/do_ambiente " }, ler)).toEqual({ ok: true, valor: { uri: "mongodb://127.0.0.1/do_ambiente", origem: "ambiente" } });
      expect(leituras).toBe(0);
      expect(resolverUri({}, ler)).toEqual({ ok: true, valor: { uri: "mongodb://127.0.0.1/do_arquivo", origem: "arquivo-env" } });
      expect(resolverUri({ MONGODB_URI: "" }, () => null).ok).toBe(false);
    });
  });

  describe("recusas antes de qualquer pergunta ou conexão (proteções do seed:admin preservadas)", () => {
    it("fora do código-fonte ou em ambiente implantado (dist, NODE_ENV, Render, Docker)", async () => {
      const cenarios: AmbienteDeExecucao[] = [
        { ...EXECUCAO_LOCAL, arquivoDeEntrada: "C:\\app\\dist\\scripts\\criar-admin.js" },
        { ...EXECUCAO_LOCAL, variaveis: { NODE_ENV: "production" } },
        { ...EXECUCAO_LOCAL, variaveis: { RENDER: "true" } },
        { ...EXECUCAO_LOCAL, existeArquivo: (caminho: string) => caminho === "/.dockerenv" },
      ];
      for (const execucao of cenarios) {
        const abridor = abridorQueNaoConecta();
        const { codigo, perguntas, texto } = await executar(roteiro("a@mariela.dev"), abridor.abrir, { execucao });
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(perguntas).toEqual([]);
        expect(abridor.chamadas).toEqual([]);
        expect(texto).toContain("Nenhuma conexão foi aberta");
      }
    });

    it("sem terminal interativo (pipe/arquivo) é recusado: a senha nunca é lida de outra fonte", async () => {
      const abridor = abridorQueNaoConecta();
      const { codigo, perguntas, texto, leuArquivoEnv } = await executar(roteiro("a@mariela.dev"), abridor.abrir, { interativo: false });
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain("terminal interativo");
      expect(perguntas).toEqual([]);
      expect(leuArquivoEnv()).toBe(false);
      expect(abridor.chamadas).toEqual([]);
    });

    it("URI ausente, sem banco no path ou apontando para mariela_dev_local", async () => {
      const casos: Record<string, string | undefined>[] = [{}, { MONGODB_URI: "mongodb://127.0.0.1:27017" }, { MONGODB_URI: "mongodb://127.0.0.1:27017/mariela_dev_local" }];
      for (const variaveis of casos) {
        const abridor = abridorQueNaoConecta();
        const { codigo, perguntas } = await executar(roteiro("a@mariela.dev"), abridor.abrir, { variaveis });
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(perguntas).toEqual([]);
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("`bun run admin:criar` sem terminal interativo recusa antes de ler o .env ou conectar (processo real)", async () => {
      const ambiente: Record<string, string> = {};
      for (const [nome, valor] of Object.entries(process.env)) {
        if (valor !== undefined && !nome.startsWith("ADMIN_") && nome !== "MONGODB_URI") ambiente[nome] = valor;
      }
      const processo = Bun.spawn(["bun", "run", "admin:criar"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), env: ambiente, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      processo.stdin.end();
      const saida = await new Response(processo.stdout).text();
      expect(await processo.exited).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(saida).toContain("terminal interativo");
      expect(saida).toContain("Nenhuma conexão foi aberta");
    });
  });

  describe("perguntas: validação, tentativas e cancelamento (sem conexão)", () => {
    const email = "novo.admin.interativo@mariela.dev";

    it("cancelar (Ctrl+C) em cada pergunta antes do banco: código 4, nenhuma conexão", async () => {
      const base = roteiro(email);
      for (let indice = 0; indice < 5; indice++) {
        const abridor = abridorQueNaoConecta();
        const respostas = [...base.slice(0, indice), null];
        const { codigo, texto } = await executar(respostas, abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.cancelado);
        expect(texto).toContain("Cancelado pelo operador. Nada foi alterado.");
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("e-mail inválido: avisa e pergunta de novo; após 3 tentativas recusa sem conectar", async () => {
      const abridor = abridorQueNaoConecta();
      const umErro = await executar(["sem-arroba", ...roteiro(email)], abridor.abrir);
      expect(umErro.texto).toContain("O e-mail não tem formato de e-mail válido.");
      expect(umErro.perguntas.filter((p) => p.texto.startsWith("E-mail")).length).toBe(2);
      expect(abridor.chamadas).toEqual([MONGODB_URI_TESTE]); // seguiu até o dry-run (o abridor do teste recusa conectar)

      const esgotado = abridorQueNaoConecta();
      const { codigo, texto } = await executar(["x", "dois@@x", "com espaco@x.y"], esgotado.abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain(`Dados inválidos após ${TENTATIVAS_POR_CAMPO} tentativas.`);
      expect(esgotado.chamadas).toEqual([]);
    });

    it("nome vazio ou com mais de 120 caracteres é recusado", async () => {
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar([email, "   ", "x".repeat(121), ""], abridor.abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain("O nome não pode ficar vazio.");
      expect(texto).toContain("O nome excede 120 caracteres.");
      expect(abridor.chamadas).toEqual([]);
    });

    it("senha abaixo de 8 ou acima de 200 é recusada sem ecoar o valor; a senha é sempre pergunta oculta", async () => {
      const longa = "L".repeat(201);
      const abridor = abridorQueNaoConecta();
      const { codigo, texto, perguntas } = await executar([email, NOME, "curta77", longa, "sete777"], abridor.abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain("A senha deve ter de 8 a 200 caracteres (o valor não é exibido).");
      expect(texto).not.toContain(longa);
      expect(texto).not.toContain("curta77");
      expect(perguntas.filter((p) => p.texto.startsWith("Senha")).every((p) => p.oculto)).toBe(true);
      expect(abridor.chamadas).toEqual([]);
    });

    it("senhas divergentes: pede as duas de novo; após 3 divergências recusa", async () => {
      const abridor = abridorQueNaoConecta();
      const umErro = await executar([email, NOME, SENHA, "outra-senha-1", SENHA, SENHA, BANCO_DE_TESTE], abridor.abrir);
      expect(umErro.texto).toContain("As senhas não conferem.");
      expect(abridor.chamadas).toHaveLength(1);
      expect(umErro.perguntas.filter((p) => p.oculto)).toHaveLength(4);

      const esgotado = abridorQueNaoConecta();
      const { codigo } = await executar([email, NOME, SENHA, "a-1234567", SENHA, "b-1234567", SENHA, "c-1234567"], esgotado.abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(esgotado.chamadas).toEqual([]);
    });

    it("nome do banco digitado diferente do banco da URI: recusa (equivale a --banco divergente), sem conectar", async () => {
      for (const digitado of ["outro_banco", "MARIELA_TEST", ""]) {
        const abridor = abridorQueNaoConecta();
        const { codigo, texto } = await executar([email, NOME, SENHA, SENHA, digitado], abridor.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain(`não é exatamente "${BANCO_DE_TESTE}"`);
        expect(abridor.chamadas).toEqual([]);
      }
    });

    it("variáveis ADMIN_* do ambiente ou do .env são IGNORADAS: valem só as respostas digitadas", async () => {
      const abridor = abridorQueNaoConecta();
      const { perguntas, texto } = await executar(roteiro(email), abridor.abrir, {
        variaveis: { ADMIN_EMAIL: "injetado@x.y", ADMIN_NAME: "Injetado", ADMIN_PASSWORD: "senha-injetada-1", ADMIN_SEED_CONFIRM: "injetado@x.y" },
        lerArquivoEnv: () => `ADMIN_PASSWORD=senha-do-arquivo-1\nMONGODB_URI=${MONGODB_URI_TESTE}`,
      });
      expect(perguntas.map((p) => p.texto.split(" ")[0])).toEqual(["E-mail", "Nome:", "Senha", "Repita", "Digite"]);
      expect(texto).toContain("chave MONGODB_URI do arquivo .env do backend");
      expect(texto).not.toContain("injetado");
      expect(texto).not.toContain("senha-do-arquivo-1");
      expect(abridor.chamadas).toEqual([MONGODB_URI_TESTE]);
    });
  });

  describe("banco PROTEGIDO (produção ou desconhecido)", () => {
    const email = "admin.producao@mariela.dev";
    const variaveis = { MONGODB_URI: URI_PRODUCAO };

    it("exige o nome do banco digitado DUAS vezes (equivale a --apply + --confirmar-producao); errar a segunda recusa sem conectar", async () => {
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar([email, NOME, SENHA, SENHA, "marielaDB", "marieladb"], abridor.abrir, { variaveis });
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain("Banco de destino: marielaDB");
      expect(texto).toContain("PROTEGIDO");
      expect(abridor.chamadas).toEqual([]);
    });

    it("com as duas confirmações exatas a escrita é autorizada (o abridor do teste se recusa a conectar); URI e senha nunca aparecem", async () => {
      const abridor = abridorQueNaoConecta();
      const { codigo, texto, perguntas } = await executar([email, NOME, SENHA, SENHA, "marielaDB", "marielaDB"], abridor.abrir, { variaveis });
      expect(perguntas.filter((p) => p.texto.includes("nome exato do banco"))).toHaveLength(1);
      expect(abridor.chamadas).toEqual([URI_PRODUCAO]);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.falha);
      expect(texto).toContain("<uri oculta>");
    });

    it("banco de teste local não pede a segunda confirmação de produção", async () => {
      const abridor = abridorQueNaoConecta();
      const { perguntas } = await executar(roteiro("a@mariela.dev"), abridor.abrir);
      expect(perguntas.some((p) => p.texto.includes("nome exato do banco"))).toBe(false);
    });
  });

  describe("falhas do provisionamento (contexto falso)", () => {
    const email = "admin.falha@mariela.dev";
    const contextoFalso = (criar: ContextoSeed["service"]["criar"]): AbrirContexto => async () => ({
      service: { avaliar: async () => ({ status: "inexistente" as const, email, proximoCodigo: "USR-0042" }), criar },
      conexao: { name: BANCO_DE_TESTE } as Connection,
      fechar: async () => undefined,
    });

    it("erro na criação: código 3, mensagem sem URI nem senha", async () => {
      const { codigo, texto } = await executar(
        roteiro(email),
        contextoFalso(async () => {
          throw new Error(`conexão perdida com ${MONGODB_URI_TESTE} usando ${SENHA}`);
        }),
      );
      expect(codigo).toBe(CODIGOS_DE_SAIDA.falha);
      expect(texto).toContain("ERRO durante a execução");
    });

    it("ADMIN criado mas ADMIN_CREATED não gravado: diz que o usuário existe e pede registro manual", async () => {
      const usuario = { id: "u1", codigo: "USR-0042", nome: NOME, email, tipo: "ADMIN" as const, ativo: true };
      const { codigo, texto } = await executar(
        roteiro(email),
        contextoFalso(async () => {
          throw new FalhaAuditoriaCriacaoAdmin(usuario, new Error("gravação recusada"));
        }),
      );
      expect(codigo).toBe(CODIGOS_DE_SAIDA.falha);
      expect(texto).toContain("o usuário EXISTE e já pode entrar");
      expect(texto).toContain("registre a criação manualmente");
    });

    it("conexão aberta em banco diferente do confirmado: aborta antes de consultar", async () => {
      let consultou = false;
      const abrir: AbrirContexto = async () => ({
        service: {
          avaliar: async () => {
            consultou = true;
            return { status: "inexistente" as const, email, proximoCodigo: "USR-1" };
          },
          criar: async () => {
            throw new Error("não deveria criar");
          },
        },
        conexao: { name: "outro" } as Connection,
        fechar: async () => undefined,
      });
      const { codigo } = await executar(roteiro(email), abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.falha);
      expect(consultou).toBe(false);
    });
  });

  describe("integração com mariela_test (MESMO contexto mínimo do seed:admin)", () => {
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

    const valorDaSequencia = async () => (await connection.collection<{ _id: string; valor: number }>("sequencias").findOne({ _id: "usuario" }))?.valor ?? 0;
    const COMANDOS_DE_ESCRITA = ["insert", "update", "delete", "findAndModify", "bulkWrite"];
    const COMANDOS_DE_ESTRUTURA = ["createIndexes", "dropIndexes", "create", "drop", "dropDatabase", "collMod", "renameCollection"];

    function instrumentado() {
      const comandos: { nome: string; colecao: unknown }[] = [];
      const abrir = criarAbridorDeContexto({
        aoConectar: (conexao) => {
          conexao.getClient().on("commandStarted", (evento: { commandName: string; command: Record<string, unknown> }) => {
            comandos.push({ nome: evento.commandName, colecao: evento.command[evento.commandName] });
          });
        },
      });
      return { abrir, comandos, escritas: () => comandos.filter((c) => COMANDOS_DE_ESCRITA.includes(c.nome) || COMANDOS_DE_ESTRUTURA.includes(c.nome)) };
    }

    it("criação autorizada: cria o ADMIN, grava ADMIN_CREATED (sem senha) e o login funciona; escreve só sequência, usuário e evento", async () => {
      const email = emailUnico("criacao");
      const sequenciaAntes = await valorDaSequencia();
      const instr = instrumentado();

      const { codigo, texto } = await executar(roteiro(`  ${email.toUpperCase()}  `), instr.abrir);

      const codigoEsperado = `USR-${String(sequenciaAntes + 1).padStart(4, "0")}`;
      expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(texto).toContain(`Banco de destino: ${BANCO_DE_TESTE}`);
      expect(texto).toContain(`Código previsto: ${codigoEsperado}`);
      expect(texto).toContain("Senha: definida (não exibida)");
      expect(texto).toContain(`Administrador criado: ${codigoEsperado} <${email}>`);
      expect(texto).toContain("Auditoria: ADMIN_CREATED registrado");
      expect(instr.escritas()).toEqual([
        { nome: "findAndModify", colecao: "sequencias" },
        { nome: "insert", colecao: "usuarios" },
        { nome: "insert", colecao: "eventos_auth" },
      ]);

      const usuario = await connection.collection("usuarios").findOne({ email });
      expect(usuario).toMatchObject({ codigo: codigoEsperado, nome: NOME, email, role: "ADMIN", ativo: true });
      expect(String(usuario?.["senhaHash"])).toStartWith("$argon2id$v=19$m=19456,t=2,");
      const eventos = await connection.collection("eventos_auth").find({ usuarioId: usuario?.["_id"] }).toArray();
      expect(eventos).toHaveLength(1);
      expect(eventos[0]).toMatchObject({ tipo: "ADMIN_CREATED", origem: "comando:seed:admin", ip: null, userAgent: null });
      expect(JSON.stringify(eventos)).not.toContain(SENHA);
      expect(JSON.stringify(eventos)).not.toContain(String(usuario?.["senhaHash"]));

      const sessao = await auth.login({ usuario: email, senha: SENHA }, contextoLogin);
      expect(sessao.usuario).toMatchObject({ email, tipo: "ADMIN" });
      await auth.logout({ refreshToken: sessao.refreshToken });
    });

    it("ADMIN já existente: avisa ANTES da confirmação final, sai com 1 e não escreve nada", async () => {
      const email = emailUnico("existente");
      expect((await executar(roteiro(email), criarAbridorDeContexto())).codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      const documento = await connection.collection("usuarios").findOne({ email });
      const sequencia = await valorDaSequencia();
      const instr = instrumentado();

      const { codigo, texto, perguntas, restante } = await executar(roteiro(email), instr.abrir);

      expect(codigo).toBe(CODIGOS_DE_SAIDA.jaExiste);
      expect(texto).toContain("Já existe um usuário com este e-mail");
      expect(perguntas.some((p) => p.texto.includes("CRIAR"))).toBe(false);
      expect(restante).toEqual(["CRIAR"]);
      expect(instr.escritas()).toEqual([]);
      expect(await connection.collection("usuarios").findOne({ email })).toEqual(documento);
      expect(await valorDaSequencia()).toBe(sequencia);
      expect(await connection.collection("eventos_auth").countDocuments({ usuarioId: documento?.["_id"], tipo: "ADMIN_CREATED" })).toBe(1);
    });

    it("confirmação final recusada ou cancelada: código 4 e NENHUMA escrita (só a leitura do dry-run)", async () => {
      for (const final of ["sim", "criar", "", null]) {
        const email = emailUnico("recusada");
        const sequencia = await valorDaSequencia();
        const instr = instrumentado();
        const { codigo, texto } = await executar(roteiro(email, final), instr.abrir);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.cancelado);
        expect(texto).toContain("Nada foi alterado.");
        expect(instr.comandos.map((c) => c.nome)).toContain("find");
        expect(instr.escritas()).toEqual([]);
        expect(await connection.collection("usuarios").findOne({ email })).toBeNull();
        expect(await valorDaSequencia()).toBe(sequencia);
      }
    });
  });
});
