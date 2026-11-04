import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken, getModelToken, MongooseModule } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { createConnection, Types, type Connection, type Model } from "mongoose";
import { garantirItemConfiguracao } from "../test-utils/configuracoes-teste.util.js";
import { liberarTudo, novoPonto } from "../test-utils/barreira.util.js";
import { MONGODB_URI_TESTE } from "../test-utils/mongo-teste.util.js";
import { MovimentoCaixa, type MovimentoCaixaDocument } from "../modules/caixas/schemas/movimento-caixa.schema.js";
import { ConfiguracoesModule } from "../modules/configuracoes/configuracoes.module.js";
import { ConfiguracoesRepository } from "../modules/configuracoes/configuracoes.repository.js";
import { ConfiguracoesService } from "../modules/configuracoes/configuracoes.service.js";
import type { Configuracao } from "../modules/configuracoes/schemas/configuracao.schema.js";
import { ProdutosRepository } from "../modules/produtos/produtos.repository.js";
import { ProdutosService } from "../modules/produtos/produtos.service.js";
import { normalizarCor, normalizarFormaPagamento } from "../modules/produtos/utils/normalizacao.util.js";
import { Venda, type VendaDocument } from "../modules/vendas/schemas/venda.schema.js";
import {
  abrirContextoDaAplicacao,
  analisarUri,
  CODIGOS_DE_SAIDA,
  executarComando,
  interpretarArgumentos,
  ocultarSegredos,
  validarAmbiente,
  type AbrirContexto,
  type ContextoRecuperacao,
} from "./processar-remocoes-pendentes.comando.js";

/**
 * Fase 56.4.3 — comando operacional de recuperação de remoções pendentes.
 *
 * - Validação de argumentos/ambiente: funções puras + `executarComando` com
 *   um "abridor de contexto" que só REGISTRA a chamada e se recusa a
 *   conectar — prova que toda recusa acontece antes de qualquer conexão.
 *   Nenhum teste conecta a um banco que não seja `mariela_test`.
 * - Integração: `executarComando` contra `mariela_test`, com o service REAL
 *   (um módulo Nest novo por execução, exatamente como o comando faz), e um
 *   teste com o contexto real do comando (`AppModule`).
 */

const JWT_MODULO_DE_TESTE = JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });
const USUARIO_ID = "64b000000000000000000003";
const BANCO_DE_TESTE = "mariela_test";
const ARGS_DRY_RUN = ["--banco", BANCO_DE_TESTE];
const ARGS_APPLY = ["--banco", BANCO_DE_TESTE, "--apply"];
const URI_PRODUCAO = "mongodb+srv://usuario_app:SenhaSecretaDoAtlas123@cluster0.exemplo.mongodb.net/marielaDB?retryWrites=true&w=majority";

/** Abridor de contexto que NUNCA conecta: só registra que foi chamado. */
function abridorQueNaoConecta() {
  const chamadas: string[] = [];
  const abrir: AbrirContexto = async (uri) => {
    chamadas.push(uri);
    throw new Error("este teste não pode abrir conexão");
  };
  return { abrir, chamadas };
}

/** Contexto real de teste (service real, `mariela_test`), honrando a URI recebida; `aoAbrir` instala espiões nas instâncias deste contexto. */
function abrirContextoDeTeste(aoAbrir?: (moduloDoComando: TestingModule) => void): AbrirContexto {
  return async (uri) => {
    const moduloDoComando = await Test.createTestingModule({ imports: [MongooseModule.forRoot(uri), JWT_MODULO_DE_TESTE, ConfiguracoesModule] }).compile();
    aoAbrir?.(moduloDoComando);
    const contexto: ContextoRecuperacao = {
      service: moduloDoComando.get(ConfiguracoesService),
      conexao: moduloDoComando.get<Connection>(getConnectionToken()),
      fechar: () => moduloDoComando.close(),
    };
    return contexto;
  };
}

/** `uri: null` = MONGODB_URI ausente (um `undefined` explícito cairia no valor padrão do parâmetro). */
async function executar(argv: string[], abrir: AbrirContexto, uri: string | null = MONGODB_URI_TESTE) {
  const saida: string[] = [];
  const codigo = await executarComando({ argv, uri: uri ?? undefined, escrever: (linha) => saida.push(linha), abrirContexto: abrir });
  return { codigo, texto: saida.join("\n") };
}

describe("comando processar-remocoes-pendentes (Fase 56.4.3)", () => {
  it("pré-condição: os testes de integração usam exclusivamente mariela_test em host local", () => {
    expect(analisarUri(MONGODB_URI_TESTE)).toEqual({ banco: BANCO_DE_TESTE, local: true });
  });

  describe("proteção de ambiente — validação ANTES de qualquer conexão", () => {
    it("17. --banco ausente é rejeitado", async () => {
      expect(interpretarArgumentos([])).toEqual({ ok: false, erro: 'O parâmetro "--banco <nome-do-banco>" é obrigatório.' });
      expect(interpretarArgumentos(["--apply"])).toMatchObject({ ok: false });
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar(["--apply"], abridor.abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain("é obrigatório");
      expect(abridor.chamadas).toEqual([]);
    });

    it("18. nome de banco inválido (ou valor ausente) é rejeitado, sem ecoar o valor", async () => {
      for (const invalido of ["mariela.test", "a/b", "banco com espaco", "x".repeat(64), "mongodb://u:p@h/db"]) {
        expect(interpretarArgumentos(["--banco", invalido])).toEqual({ ok: false, erro: "Nome de banco inválido em --banco (use só letras, números, _ ou -)." });
      }
      expect(interpretarArgumentos(["--banco"])).toEqual({ ok: false, erro: 'O parâmetro "--banco" exige um valor.' });
      expect(interpretarArgumentos(["--banco", "--apply"])).toEqual({ ok: false, erro: 'O parâmetro "--banco" exige um valor.' });
    });

    it("19. banco informado diferente do banco da URI é rejeitado antes de conectar", async () => {
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar(["--banco", "outro_banco"], abridor.abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain('O banco informado em --banco ("outro_banco") é diferente do banco da MONGODB_URI configurada ("mariela_test").');
      expect(texto).toContain("Nenhuma conexão foi aberta");
      expect(abridor.chamadas).toEqual([]);
    });

    it("20. mariela_dev_local é recusado — pelo --banco e pela URI configurada", async () => {
      const abridor = abridorQueNaoConecta();
      const pelaOpcao = await executar(["--banco", "mariela_dev_local"], abridor.abrir, "mongodb://127.0.0.1:27017/mariela_dev_local");
      expect(pelaOpcao.codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(pelaOpcao.texto).toContain('O banco "mariela_dev_local" é recusado por este comando.');
      const pelaUri = await executar(["--banco", BANCO_DE_TESTE], abridor.abrir, "mongodb://127.0.0.1:27017/mariela_dev_local");
      expect(pelaUri.codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(pelaUri.texto).toContain('A MONGODB_URI configurada aponta para "mariela_dev_local", recusado por este comando.');
      expect(abridor.chamadas).toEqual([]);
    });

    it("21. produção NÃO pode ser alterada com --apply sozinho (recusado antes de conectar)", async () => {
      expect(analisarUri(URI_PRODUCAO)).toEqual({ banco: "marielaDB", local: false });
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar(["--banco", "marielaDB", "--apply"], abridor.abrir, URI_PRODUCAO);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain('Escrita em banco protegido ("marielaDB") exige "--apply" E "--confirmar-producao marielaDB". "--apply" sozinho não autoriza.');
      expect(abridor.chamadas).toEqual([]);
      // Sem --apply, a mesma seleção só seria autorizada em modo somente leitura (não executado aqui).
      expect(validarAmbiente({ banco: "marielaDB", aplicar: false, confirmacaoProducao: null }, URI_PRODUCAO)).toMatchObject({ ok: true, valor: { ambiente: "protegido", modo: "dry-run" } });
    });

    it("22. produção exige a confirmação adicional EXATA; confirmação genérica não existe; mariela_test remoto também é protegido", async () => {
      const abridor = abridorQueNaoConecta();
      for (const confirmacao of ["marieladb", "MARIELADB", "marielaDB_staging", "sim"]) {
        const { codigo, texto } = await executar(["--banco", "marielaDB", "--apply", "--confirmar-producao", confirmacao], abridor.abrir, URI_PRODUCAO);
        expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
        expect(texto).toContain('"--confirmar-producao" não corresponde EXATAMENTE ao banco selecionado.');
      }
      expect((await executar(["--banco", "marielaDB", "--apply", "--force"], abridor.abrir, URI_PRODUCAO)).texto).toContain('Parâmetro desconhecido "--force".');
      expect(abridor.chamadas).toEqual([]);
      // Só a combinação exata autoriza (decisão pura: este teste NÃO executa nada em produção).
      expect(validarAmbiente({ banco: "marielaDB", aplicar: true, confirmacaoProducao: "marielaDB" }, URI_PRODUCAO)).toMatchObject({
        ok: true,
        valor: { ambiente: "protegido", modo: "apply" },
      });
      const testeRemoto = "mongodb+srv://u:p@cluster0.exemplo.mongodb.net/mariela_test";
      expect(validarAmbiente({ banco: BANCO_DE_TESTE, aplicar: true, confirmacaoProducao: null }, testeRemoto)).toMatchObject({ ok: false });
      expect(validarAmbiente({ banco: BANCO_DE_TESTE, aplicar: true, confirmacaoProducao: null }, "mongodb://10.0.0.5:27017/mariela_test")).toMatchObject({ ok: false });
      // --confirmar-producao sem --apply, ou num banco de teste local, é combinação inválida.
      expect(interpretarArgumentos(["--banco", "marielaDB", "--confirmar-producao", "marielaDB"])).toEqual({
        ok: false,
        erro: '"--confirmar-producao" só pode ser usado junto com "--apply".',
      });
      expect(validarAmbiente({ banco: BANCO_DE_TESTE, aplicar: true, confirmacaoProducao: BANCO_DE_TESTE }, MONGODB_URI_TESTE)).toEqual({
        ok: false,
        erro: '"--confirmar-producao" não se aplica a um banco de teste local.',
      });
    });

    it("23. parâmetros desconhecidos, repetidos ou posicionais são rejeitados", async () => {
      expect(interpretarArgumentos(["--banco", BANCO_DE_TESTE, "--dry-run"])).toEqual({ ok: false, erro: 'Parâmetro desconhecido "--dry-run".' });
      expect(interpretarArgumentos(["--banco=mariela_test"])).toEqual({ ok: false, erro: "Parâmetro desconhecido (valor não exibido)." });
      expect(interpretarArgumentos(["mariela_test"])).toEqual({ ok: false, erro: "Parâmetro desconhecido (valor não exibido)." });
      expect(interpretarArgumentos(["--banco", BANCO_DE_TESTE, "--apply", "--apply"])).toEqual({ ok: false, erro: 'Parâmetro repetido "--apply".' });
      expect(interpretarArgumentos(["--banco", "a", "--banco", "b"])).toEqual({ ok: false, erro: 'Parâmetro repetido "--banco".' });
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar(["--banco", BANCO_DE_TESTE, "--tudo"], abridor.abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain("Uso: bun run src/scripts/processar-remocoes-pendentes.ts");
      expect(abridor.chamadas).toEqual([]);
    });

    it("24. URI e credenciais nunca aparecem na saída (recusas, valores colados por engano, erros de execução)", async () => {
      const abridor = abridorQueNaoConecta();
      const recusa = await executar(["--banco", "outro"], abridor.abrir, URI_PRODUCAO);
      const colada = await executar(["--banco", URI_PRODUCAO], abridor.abrir, URI_PRODUCAO);
      for (const { texto } of [recusa, colada]) {
        expect(texto).not.toContain("SenhaSecretaDoAtlas123");
        expect(texto).not.toContain("usuario_app");
        expect(texto).not.toContain("mongodb");
        expect(texto).not.toContain("cluster0");
      }
      // Erro em execução autorizada: a mensagem do erro é saneada antes de ser exibida.
      const uriLocalComCredenciais = "mongodb://operador:SenhaLocal987@127.0.0.1:27017/mariela_test";
      const falhaAoAbrir: AbrirContexto = async () => {
        throw new Error(`falha ao conectar em ${uriLocalComCredenciais} (operador:SenhaLocal987)`);
      };
      const execucao = await executar(ARGS_DRY_RUN, falhaAoAbrir, uriLocalComCredenciais);
      expect(execucao.codigo).toBe(CODIGOS_DE_SAIDA.falha);
      expect(execucao.texto).not.toContain("SenhaLocal987");
      expect(execucao.texto).not.toContain("operador");
      expect(execucao.texto).not.toContain("mongodb://");
      expect(ocultarSegredos(`x ${URI_PRODUCAO} y`, URI_PRODUCAO)).toBe("x <uri oculta> y");
    });

    it("25. nenhuma conexão (portanto nenhuma escrita) antes da validação; conexão em banco divergente aborta antes de qualquer consulta", async () => {
      const abridor = abridorQueNaoConecta();
      const recusados = [
        await executar([], abridor.abrir),
        await executar(["--banco", "x", "--y"], abridor.abrir),
        await executar(ARGS_APPLY, abridor.abrir, null),
        await executar(ARGS_APPLY, abridor.abrir, "mongodb://127.0.0.1:27017"),
        await executar(["--banco", "marielaDB", "--apply"], abridor.abrir, URI_PRODUCAO),
      ];
      expect(recusados.map(({ codigo }) => codigo)).toEqual(Array(5).fill(CODIGOS_DE_SAIDA.recusado));
      expect(abridor.chamadas).toEqual([]);

      // Defesa em profundidade: se a conexão aberta não for o banco validado, nada é consultado.
      const conexaoNaoAberta = createConnection(); // nenhuma conexão real: `name` indefinido
      let consultou = false;
      const contextoDivergente: AbrirContexto = async () => ({
        service: {
          avaliarRemocoesPendentes: async () => {
            consultou = true;
            return [];
          },
          processarRemocoesPendentes: async () => {
            consultou = true;
            return { processadas: [], malformadas: [] };
          },
        },
        conexao: conexaoNaoAberta,
        fechar: async () => undefined,
      });
      const divergente = await executar(ARGS_APPLY, contextoDivergente);
      expect(divergente.codigo).toBe(CODIGOS_DE_SAIDA.falha);
      expect(divergente.texto).toContain('ERRO: a conexão aberta não aponta para "mariela_test" — operação abortada antes de qualquer consulta.');
      expect(consultou).toBe(false);
    });
  });

  describe("integração com mariela_test (service real)", () => {
    let moduleRef: TestingModule;
    let service: ConfiguracoesService;
    let repositorio: ConfiguracoesRepository;
    let produtosService: ProdutosService;
    let produtosRepositorio: ProdutosRepository;
    let connection: Connection;
    let vendaModel: Model<VendaDocument>;
    let movimentoModel: Model<MovimentoCaixaDocument>;
    let contador = 0;
    const colecaoConfiguracoes = () => connection.collection<Configuracao>("configuracoes");

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [MongooseModule.forRoot(MONGODB_URI_TESTE), JWT_MODULO_DE_TESTE, ConfiguracoesModule] }).compile();
      service = moduleRef.get(ConfiguracoesService);
      repositorio = moduleRef.get(ConfiguracoesRepository, { strict: false });
      produtosService = moduleRef.get(ProdutosService, { strict: false });
      produtosRepositorio = moduleRef.get(ProdutosRepository, { strict: false });
      connection = moduleRef.get(getConnectionToken());
      vendaModel = moduleRef.get(getModelToken(Venda.name), { strict: false });
      movimentoModel = moduleRef.get(getModelToken(MovimentoCaixa.name), { strict: false });
      expect(connection.name).toBe(BANCO_DE_TESTE);
    });

    afterAll(async () => {
      await connection.collection<Configuracao>("configuracoes").deleteMany({});
      await connection.collection("eventos_configuracao").deleteMany({ usuarioId: USUARIO_ID });
      await connection.collection("produtos").deleteMany({ nome: /^Produto Comando Teste / });
      await connection.collection("vendas").deleteMany({ codigo: /^VENDA-COMANDO-TESTE-/ });
      await connection.collection("movimentos_caixa").deleteMany({ descricao: "Movimento de teste (comando de remoções pendentes)" });
      await moduleRef.close();
    });

    beforeEach(async () => {
      await garantirItemConfiguracao(service, "categorias", "Vestidos");
      await colecaoConfiguracoes().updateOne({ _id: "global" }, { $set: { remocoesPendentes: [] } });
    });

    function silenciarLogs() {
      const erro = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const aviso = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      return () => {
        erro.mockRestore();
        aviso.mockRestore();
      };
    }

    async function corNova(rotulo: string) {
      contador += 1;
      const base = `Cmd${rotulo}-${Date.now()}-${contador}`;
      await service.adicionarItem("cores", `${base}-Antes`, USUARIO_ID);
      await service.adicionarItem("cores", `${base}-Alvo`, USUARIO_ID);
      await service.adicionarItem("cores", `${base}-Depois`, USUARIO_ID);
      return `${base}-Alvo`;
    }

    async function documentoCru() {
      return colecaoConfiguracoes().findOne({ _id: "global" });
    }

    async function representacao(valor: string) {
      const documento = await documentoCru();
      const normalizado = normalizarCor(valor);
      return {
        naLista: (documento?.cores ?? []).filter((item) => normalizarCor(item) === normalizado).length,
        noEspelho: (documento?.coresNormalizadas ?? []).filter((item) => item === normalizado).length,
      };
    }

    /** Remoção interrompida logo depois do `$pull` (pendência fica no documento); `aposGravar` cria o vínculo na janela. */
    async function pendenciaInterrompida(lista: "cores" | "formasPagamento", valor: string, aposGravar: () => Promise<void> = async () => undefined) {
      const original = repositorio.removerItemComPendencia.bind(repositorio);
      const espiao = spyOn(repositorio, "removerItemComPendencia").mockImplementation(async (campo, item, dados) => {
        await original(campo, item, dados);
        await aposGravar();
        throw new Error("processo interrompido (simulado)");
      });
      try {
        await service.removerItem(lista, valor, USUARIO_ID).then(
          () => {
            throw new Error("a remoção deveria ter sido interrompida");
          },
          (erro: unknown) => expect(erro instanceof Error ? erro.message : "").toBe("processo interrompido (simulado)"),
        );
      } finally {
        espiao.mockRestore();
      }
      const pendencia = ((await documentoCru())?.remocoesPendentes ?? []).find((item) => item.valor === valor);
      if (!pendencia) throw new Error(`Nenhuma pendência para "${valor}".`);
      return pendencia;
    }

    /** Variante com a cor, validada e pausada antes de gravar; `gravar()` a grava (usado na janela depois do `$pull`). */
    async function vinculoDeCor(cor: string) {
      const produto = await produtosService.criar(
        { nome: `Produto Comando Teste ${cor}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false },
        null,
      );
      const pausa = novoPonto();
      const original = produtosRepositorio.adicionarVarianteAtomico.bind(produtosRepositorio);
      const espiao = spyOn(produtosRepositorio, "adicionarVarianteAtomico").mockImplementation(async (produtoId, variante) => {
        pausa.chegou.liberar();
        await pausa.liberacao.promessa;
        return original(produtoId, variante);
      });
      const inclusao = produtosService.adicionarVariante(produto.id, { cor }, null);
      inclusao.catch(() => undefined);
      await pausa.chegou.promessa;
      espiao.mockRestore();
      return {
        produtoId: produto.id,
        gravar: async () => {
          pausa.liberacao.liberar();
          await inclusao;
        },
        liberar: () => liberarTudo(pausa),
      };
    }

    async function pendenciaRestauravel(rotulo: string) {
      const cor = await corNova(rotulo);
      const vinculo = await vinculoDeCor(cor);
      try {
        return { cor, produtoId: vinculo.produtoId, pendencia: await pendenciaInterrompida("cores", cor, vinculo.gravar) };
      } finally {
        vinculo.liberar();
      }
    }

    async function pendenciaFinalizavel(rotulo: string) {
      const cor = await corNova(rotulo);
      return { cor, pendencia: await pendenciaInterrompida("cores", cor) };
    }

    async function pendenciaMalformada() {
      const opId = `malformada-cmd-${Date.now()}`;
      const colecaoCrua = connection.collection<{ _id: string; remocoesPendentes?: unknown[] }>("configuracoes");
      await colecaoCrua.updateOne({ _id: "global" }, { $push: { remocoesPendentes: { opId, lista: "cores", valor: "" } } });
      return opId;
    }

    /** Espião na consulta de vínculos DO CONTEXTO DO COMANDO: falha (permanente) só para a cor indicada. */
    function consultaQueFalhaPara(cor: string): (moduloDoComando: TestingModule) => void {
      return (moduloDoComando) => {
        const repositorioDoComando = moduloDoComando.get(ProdutosRepository, { strict: false });
        const original = repositorioDoComando.listarTodosAtivos.bind(repositorioDoComando);
        spyOn(repositorioDoComando, "listarTodosAtivos").mockImplementation(async (filtro) => {
          if (filtro?.["variantes.corNormalizada"] === normalizarCor(cor)) throw new Error("falha permanente simulada na consulta de vínculos");
          return original(filtro);
        });
      };
    }

    const METODOS_DE_ESCRITA = [
      "insertOne",
      "insertMany",
      "updateOne",
      "updateMany",
      "replaceOne",
      "findOneAndUpdate",
      "findOneAndReplace",
      "findOneAndDelete",
      "deleteOne",
      "deleteMany",
      "bulkWrite",
    ];

    describe("dry-run (padrão)", () => {
      it("1-3, 5, 7, 8. identifica restaurável, finalizável e malformada como PREVISÕES e não altera nenhum documento", async () => {
        const restauravel = await pendenciaRestauravel("D1a");
        const finalizavel = await pendenciaFinalizavel("D1b");
        const opIdMalformada = await pendenciaMalformada();
        const configuracaoAntes = await documentoCru();
        const produtoAntes = await connection.collection("produtos").findOne({ _id: new Types.ObjectId(restauravel.produtoId) });

        const { codigo, texto } = await executar(ARGS_DRY_RUN, abrirContextoDeTeste());

        expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria); // a malformada exige intervenção
        expect(texto).toContain("Banco selecionado: mariela_test");
        expect(texto).toContain("Modo: dry-run (somente leitura — nada será alterado)");
        expect(texto).toContain(`[PREVISÃO] restauravel opId=${restauravel.pendencia.opId} lista=cores valor=${JSON.stringify(restauravel.cor)}`);
        expect(texto).toContain(`posição=${restauravel.pendencia.posicao} em=${restauravel.pendencia.em.toISOString()}`);
        expect(texto).toContain(`[PREVISÃO] finalizavel opId=${finalizavel.pendencia.opId} lista=cores valor=${JSON.stringify(finalizavel.cor)}`);
        expect(texto).toContain(`[PREVISÃO] malformada opId=${opIdMalformada} índice=2 motivo=valor ausente ou inválido`);
        expect(texto).toContain("Resumo — PREVISÕES do dry-run (nenhuma operação foi executada, nada foi alterado):");
        expect(texto).toContain("Total de pendências encontradas: 3");
        expect(texto).toContain("Previsto para restauração: 1");
        expect(texto).toContain("Previsto para finalização: 1");
        expect(texto).toContain("Malformadas: 1");
        expect(texto).toContain("Efetivamente processado: 0 (dry-run)");
        expect(texto).toContain(`Exigem intervenção: ${opIdMalformada}`);
        expect(texto).not.toContain("[RESULTADO]");
        expect(texto).not.toContain("mongodb://");
        expect(texto).not.toContain("127.0.0.1");

        expect(await documentoCru()).toEqual(configuracaoAntes); // inclusive atualizadoEm e as pendências
        expect(await connection.collection("produtos").findOne({ _id: new Types.ObjectId(restauravel.produtoId) })).toEqual(produtoAntes);
      });

      it("4. identifica pendência INDETERMINADA (consulta falhou) sem presumir ausência de vínculo", async () => {
        const indeterminada = await pendenciaFinalizavel("D4");
        const configuracaoAntes = await documentoCru();
        const { codigo, texto } = await executar(ARGS_DRY_RUN, abrirContextoDeTeste(consultaQueFalhaPara(indeterminada.cor)));
        expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
        expect(texto).toContain(`[PREVISÃO] indeterminada opId=${indeterminada.pendencia.opId}`);
        expect(texto).toContain("NENHUMA decisão (nunca tratada como sem vínculo) (erro: Error: falha permanente simulada na consulta de vínculos)");
        expect(texto).toContain("Indeterminadas: 1");
        expect(texto).toContain("Previsto para finalização: 0");
        expect(texto).toContain(`Exigem intervenção: ${indeterminada.pendencia.opId}`);
        expect(await documentoCru()).toEqual(configuracaoAntes);
      });

      it("6. o dry-run não executa NENHUMA operação de escrita (debug da conexão do comando)", async () => {
        await pendenciaRestauravel("D6a");
        await pendenciaFinalizavel("D6b");
        await pendenciaMalformada();
        const operacoes: string[] = [];
        const { codigo } = await executar(
          ARGS_DRY_RUN,
          abrirContextoDeTeste((moduloDoComando) => {
            moduloDoComando.get<Connection>(getConnectionToken()).set("debug", (_colecao: string, metodo: string) => {
              operacoes.push(metodo);
            });
          }),
        );
        expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
        expect(operacoes).toContain("findOne");
        expect(operacoes.filter((metodo) => METODOS_DE_ESCRITA.includes(metodo))).toEqual([]);
      });
    });

    describe("aplicação (--apply)", () => {
      it("9, 10, 14, 28, 29. restaura a pendência com vínculo, finaliza a sem vínculo, mantém a malformada intacta e o espelho consistente", async () => {
        const restauravel = await pendenciaRestauravel("A1a");
        const finalizavel = await pendenciaFinalizavel("A1b");
        const opIdMalformada = await pendenciaMalformada();
        const silencio = silenciarLogs();
        let resultado: { codigo: number; texto: string };
        try {
          resultado = await executar(ARGS_APPLY, abrirContextoDeTeste());
        } finally {
          silencio();
        }
        expect(resultado.codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria); // malformada
        expect(resultado.texto).toContain("Modo: apply (as pendências SERÃO processadas)");
        expect(resultado.texto).toContain(`[RESULTADO] opId=${restauravel.pendencia.opId} lista=cores valor=${JSON.stringify(restauravel.cor)} → restaurada`);
        expect(resultado.texto).toContain(`[RESULTADO] opId=${finalizavel.pendencia.opId} lista=cores valor=${JSON.stringify(finalizavel.cor)} → finalizada`);
        expect(resultado.texto).toContain(`[RESULTADO] malformada opId=${opIdMalformada} índice=2 motivo=valor ausente ou inválido → mantida intacta, não processada`);
        expect(resultado.texto).toContain("Resumo — resultados EFETIVOS retornados pelo processamento:");
        expect(resultado.texto).toContain("Efetivamente processado: 2");
        expect(resultado.texto).toContain("Restaurado: 1");
        expect(resultado.texto).toContain("Finalizado: 1");
        expect(resultado.texto).toContain(`Exigem intervenção: ${opIdMalformada}`);
        expect(resultado.texto).not.toContain("[PREVISÃO]");

        expect(await representacao(restauravel.cor)).toEqual({ naLista: 1, noEspelho: 1 });
        expect(await representacao(finalizavel.cor)).toEqual({ naLista: 0, noEspelho: 0 });
        const restantes = (await connection.collection<{ _id: string; remocoesPendentes?: unknown[] }>("configuracoes").findOne({ _id: "global" }))?.remocoesPendentes;
        expect(restantes).toEqual([{ opId: opIdMalformada, lista: "cores", valor: "" }]); // nunca apagada em silêncio
      });

      it("11. falha de consulta preserva a pendência (mantida_falha_consulta)", async () => {
        const alvo = await pendenciaFinalizavel("A2");
        const silencio = silenciarLogs();
        try {
          const { codigo, texto } = await executar(ARGS_APPLY, abrirContextoDeTeste(consultaQueFalhaPara(alvo.cor)));
          expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
          expect(texto).toContain(`opId=${alvo.pendencia.opId} lista=cores valor=${JSON.stringify(alvo.cor)} → mantida_falha_consulta`);
          expect(texto).toContain("Mantido por falha de consulta: 1");
        } finally {
          silencio();
        }
        expect((await documentoCru())?.remocoesPendentes).toEqual([alvo.pendencia]);
      });

      it("12. falha de restauração preserva a pendência (mantida_falha_restauracao)", async () => {
        const alvo = await pendenciaRestauravel("A3");
        const silencio = silenciarLogs();
        try {
          const { codigo, texto } = await executar(
            ARGS_APPLY,
            abrirContextoDeTeste((moduloDoComando) => {
              spyOn(moduloDoComando.get(ConfiguracoesRepository, { strict: false }), "restaurarItemLista").mockImplementation(async () => {
                throw new Error("falha permanente simulada na restauração");
              });
            }),
          );
          expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
          expect(texto).toContain(`opId=${alvo.pendencia.opId} lista=cores valor=${JSON.stringify(alvo.cor)} → mantida_falha_restauracao`);
          expect(texto).toContain("Mantido por falha de restauração: 1");
          expect(texto).toContain(`Exigem intervenção: ${alvo.pendencia.opId}`);
        } finally {
          silencio();
        }
        expect((await documentoCru())?.remocoesPendentes).toEqual([alvo.pendencia]);
        expect(await representacao(alvo.cor)).toEqual({ naLista: 0, noEspelho: 0 });
      });

      it("13. falha de finalização preserva a pendência (mantida_falha_finalizacao)", async () => {
        const alvo = await pendenciaFinalizavel("A4");
        const silencio = silenciarLogs();
        try {
          const { codigo, texto } = await executar(
            ARGS_APPLY,
            abrirContextoDeTeste((moduloDoComando) => {
              spyOn(moduloDoComando.get(ConfiguracoesRepository, { strict: false }), "finalizarRemocaoPendente").mockImplementation(async () => {
                throw new Error("falha permanente simulada na finalização");
              });
            }),
          );
          expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
          expect(texto).toContain(`opId=${alvo.pendencia.opId} lista=cores valor=${JSON.stringify(alvo.cor)} → mantida_falha_finalizacao`);
          expect(texto).toContain("Mantido por falha de finalização: 1");
        } finally {
          silencio();
        }
        expect((await documentoCru())?.remocoesPendentes).toEqual([alvo.pendencia]);
      });

      it("15, 30. segunda execução não duplica nem altera operações concluídas (idempotente)", async () => {
        const restauravel = await pendenciaRestauravel("A5a");
        await pendenciaFinalizavel("A5b");
        expect((await executar(ARGS_APPLY, abrirContextoDeTeste())).codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
        const depoisDaPrimeira = await documentoCru();

        const segunda = await executar(ARGS_APPLY, abrirContextoDeTeste());
        expect(segunda.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
        expect(segunda.texto).toContain("Total de pendências encontradas: 0");
        expect(segunda.texto).toContain("Efetivamente processado: 0");
        expect(await documentoCru()).toEqual(depoisDaPrimeira);
        expect(await representacao(restauravel.cor)).toEqual({ naLista: 1, noEspelho: 1 });
      });

      it("16. duas execuções concorrentes da mesma pendência: uma restaura, a outra reconhece 'já concluída' — sem corromper", async () => {
        const alvo = await pendenciaRestauravel("A6");
        const pausa = novoPonto();
        const execucaoA = executar(
          ARGS_APPLY,
          abrirContextoDeTeste((moduloDoComando) => {
            const repositorioDoComando = moduloDoComando.get(ProdutosRepository, { strict: false });
            const original = repositorioDoComando.listarTodosAtivos.bind(repositorioDoComando);
            spyOn(repositorioDoComando, "listarTodosAtivos").mockImplementation(async (filtro) => {
              const resultado = await original(filtro);
              if (filtro?.["variantes.corNormalizada"] === normalizarCor(alvo.cor)) {
                pausa.chegou.liberar(); // A consultou os vínculos e para antes de restaurar
                await pausa.liberacao.promessa;
              }
              return resultado;
            });
          }),
        );
        try {
          await pausa.chegou.promessa;
          const execucaoB = await executar(ARGS_APPLY, abrirContextoDeTeste()); // B roda inteira enquanto A está parada
          pausa.liberacao.liberar();
          const resultadoA = await execucaoA;
          expect(execucaoB.texto).toContain(`opId=${alvo.pendencia.opId} lista=cores valor=${JSON.stringify(alvo.cor)} → restaurada`);
          expect(resultadoA.texto).toContain(`opId=${alvo.pendencia.opId} lista=cores valor=${JSON.stringify(alvo.cor)} → ja_concluida`);
          expect(resultadoA.texto).toContain("Já concluído por outra execução: 1");
          expect(await representacao(alvo.cor)).toEqual({ naLista: 1, noEspelho: 1 });
          expect((await documentoCru())?.remocoesPendentes).toEqual([]);
        } finally {
          liberarTudo(pausa);
          await execucaoA.catch(() => undefined);
        }
      });

      it("26, 27. forma de pagamento com venda e movimento gravados na janela: restaurada; vendas e movimentos históricos intactos", async () => {
        contador += 1;
        const forma = `Forma Cmd ${Date.now()}-${contador}`;
        await service.adicionarItem("formasPagamento", forma, USUARIO_ID);
        const criados: { vendaId?: Types.ObjectId; movimentoId?: Types.ObjectId } = {};
        const pendencia = await pendenciaInterrompida("formasPagamento", forma, async () => {
          criados.vendaId = (
            await vendaModel.create({
              codigo: `VENDA-COMANDO-TESTE-${Date.now()}-${contador}`,
              numero: `8${String(contador).padStart(5, "0")}`,
              dataVenda: new Date(),
              clienteNome: "Consumidor final",
              vendedorId: "000000000000000000000001",
              vendedorNome: "Vendedora Teste",
              totalItens: 1,
              valorBruto: 100,
              valorFinal: 100,
              formaPagamento: forma,
            })
          )._id;
          criados.movimentoId = (
            await movimentoModel.create({
              caixaId: new Types.ObjectId(),
              dataHora: new Date(),
              tipo: "injecao",
              origem: "manual",
              descricao: "Movimento de teste (comando de remoções pendentes)",
              formaPagamento: forma,
              valor: 10,
              sentido: "entrada",
            })
          )._id;
        });
        const vendaAntes = await connection.collection("vendas").findOne({ _id: criados.vendaId });
        const movimentoAntes = await connection.collection("movimentos_caixa").findOne({ _id: criados.movimentoId });
        expect(vendaAntes).not.toBeNull();
        expect(movimentoAntes).not.toBeNull();

        const { codigo, texto } = await executar(ARGS_APPLY, abrirContextoDeTeste());
        expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
        expect(texto).toContain(`opId=${pendencia.opId} lista=formasPagamento valor=${JSON.stringify(forma)} → restaurada`);
        const documento = await documentoCru();
        expect(documento?.formasPagamento.filter((item) => item === forma)).toHaveLength(1);
        expect(documento?.formasPagamentoNormalizadas.filter((item) => item === normalizarFormaPagamento(forma))).toHaveLength(1);
        expect(await connection.collection("vendas").findOne({ _id: criados.vendaId })).toEqual(vendaAntes);
        expect(await connection.collection("movimentos_caixa").findOne({ _id: criados.movimentoId })).toEqual(movimentoAntes);
      });
    });

    it("contexto REAL do comando (AppModule) em mariela_test: dry-run e depois --apply, conexão conferida antes de operar", async () => {
      const alvo = await pendenciaFinalizavel("Real");
      const uriAnterior = process.env["MONGODB_URI"];
      try {
        const previsao = await executar(ARGS_DRY_RUN, abrirContextoDaAplicacao);
        expect(previsao.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
        expect(previsao.texto).toContain(`[PREVISÃO] finalizavel opId=${alvo.pendencia.opId}`);
        expect((await documentoCru())?.remocoesPendentes).toEqual([alvo.pendencia]);

        const aplicacao = await executar(ARGS_APPLY, abrirContextoDaAplicacao);
        expect(aplicacao.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
        expect(aplicacao.texto).toContain(`opId=${alvo.pendencia.opId} lista=cores valor=${JSON.stringify(alvo.cor)} → finalizada`);
        expect((await documentoCru())?.remocoesPendentes).toEqual([]);
        for (const { texto } of [previsao, aplicacao]) expect(texto).not.toContain("mongodb://");
      } finally {
        if (uriAnterior === undefined) delete process.env["MONGODB_URI"];
        else process.env["MONGODB_URI"] = uriAnterior;
      }
    });
  });
});
