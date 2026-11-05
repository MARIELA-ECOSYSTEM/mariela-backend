import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import { createConnection, mongo, Types, type Connection } from "mongoose";
import { MONGODB_URI_TESTE } from "../test-utils/mongo-teste.util.js";
import { urlImagemPrincipalDaGaleria } from "../modules/produtos/utils/midias.util.js";
import type { AmbienteDeExecucao } from "./comando-local.util.js";
import {
  abrirContextoDoComando,
  CODIGOS_DE_SAIDA,
  criarAbridorDeContexto,
  executarComando,
  validarAmbiente,
  type AbrirContexto,
  type ContextoMigracao,
} from "./migrar-midias-legadas.comando.js";
import { idMidiaLegada } from "./migrar-midias-legadas.plano.js";

/**
 * Fase 60.2 — comando `migrar-midias-legadas`.
 * - Proteções: toda recusa acontece ANTES de conectar (abridor que se recusa a conectar e registra a chamada).
 * - Integração: contexto REAL do comando contra `mariela_test` (único banco usado), com instrumentação do driver
 *   (todo comando enviado ao servidor) e do Mongoose instalada antes de qualquer model ser compilado.
 */

const BANCO = "mariela_test";
const BASE = "https://media.exemplo.com";
const UUID_A = "11111111-2222-4333-8444-555555555555";
const ARGS_DRY_RUN = ["--banco", BANCO];
const ARGS_APPLY = ["--banco", BANCO, "--apply"];
const URI_PRODUCAO = "mongodb+srv://usuario_app:SenhaSecretaDoAtlas123@cluster0.exemplo.mongodb.net/marielaDB?retryWrites=true&w=majority";
const EXECUCAO_LOCAL: AmbienteDeExecucao = {
  arquivoDeEntrada: fileURLToPath(new URL("./migrar-midias-legadas.ts", import.meta.url)),
  variaveis: {},
  existeArquivo: () => false,
};

function abridorQueNaoConecta() {
  const chamadas: string[] = [];
  const abrir: AbrirContexto = async (uri) => {
    chamadas.push(uri);
    throw new Error("este teste não pode abrir conexão");
  };
  return { abrir, chamadas };
}

interface OpcoesExecucao {
  /** `null` = MONGODB_URI ausente. */
  uri?: string | null;
  execucao?: AmbienteDeExecucao;
  base?: string;
}

async function executar(argv: string[], abrir: AbrirContexto, opcoes: OpcoesExecucao = {}) {
  const saida: string[] = [];
  const uri = opcoes.uri === undefined ? MONGODB_URI_TESTE : opcoes.uri;
  const codigo = await executarComando({
    argv,
    uri: uri ?? undefined,
    baseUrlPublica: opcoes.base ?? BASE,
    escrever: (linha) => saida.push(linha),
    abrirContexto: abrir,
    execucao: opcoes.execucao ?? EXECUCAO_LOCAL,
    agora: () => new Date("2026-11-04T12:00:00.000Z"),
  });
  return { codigo, texto: saida.join("\n") };
}

describe("comando migrar-midias-legadas (Fase 60.2)", () => {
  describe("proteção de ambiente — recusas ANTES de qualquer conexão", () => {
    async function recusado(argv: string[], opcoes: OpcoesExecucao, trecho: string) {
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar(argv, abridor.abrir, opcoes);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain(trecho);
      expect(abridor.chamadas).toEqual([]);
      expect(texto).not.toContain("SenhaSecretaDoAtlas123");
      expect(texto).not.toContain("mongodb://");
      expect(texto).not.toContain("mongodb+srv://");
      return texto;
    }

    it("--banco é obrigatório; parâmetros desconhecidos (inclusive --confirmar-producao) e valores livres não são ecoados", async () => {
      await recusado([], {}, "é obrigatório");
      await recusado(["--apply"], {}, "é obrigatório");
      await recusado([...ARGS_APPLY, "--confirmar-producao", "marielaDB"], {}, 'Parâmetro desconhecido "--confirmar-producao"');
      const texto = await recusado(["--banco", BANCO, URI_PRODUCAO], {}, "Parâmetro desconhecido (valor não exibido)");
      expect(texto).not.toContain("cluster0");
      await recusado(["--banco", "mariela.test"], {}, "Nome de banco inválido");
    });

    it("banco de desenvolvimento recusado; --banco diferente do banco da URI recusado; URI ausente recusada", async () => {
      await recusado(["--banco", "mariela_dev_local"], {}, "recusado por este comando");
      await recusado(["--banco", "outro_banco"], {}, "é diferente do banco da MONGODB_URI");
      await recusado(ARGS_DRY_RUN, { uri: null }, "MONGODB_URI não está definida");
    });

    it("banco de produção: --apply recusado (local ou externo), sem confirmação que contorne", async () => {
      await recusado(["--banco", "marielaDB", "--apply"], { uri: "mongodb://127.0.0.1:27017/marielaDB" }, "Escrita recusada");
      await recusado(["--banco", "marielaDB", "--apply"], { uri: URI_PRODUCAO }, "conexão externa (Atlas/Render ou host remoto)");
    });

    it("conexão externa: --apply recusado mesmo com o nome do banco de teste", async () => {
      await recusado(ARGS_APPLY, { uri: "mongodb://db.remoto.exemplo.com:27017/mariela_test" }, "conexão externa");
      await recusado(ARGS_APPLY, { uri: "mongodb+srv://u:SenhaSecretaDoAtlas123@c.exemplo.mongodb.net/mariela_test" }, "conexão externa");
    });

    it("o dry-run (somente leitura) continua autorizado em banco protegido; o --apply só no banco de teste local", () => {
      expect(validarAmbiente({ banco: "marielaDB", aplicar: false }, URI_PRODUCAO)).toMatchObject({ ok: true, valor: { ambiente: "protegido", modo: "dry-run" } });
      expect(validarAmbiente({ banco: BANCO, aplicar: true }, MONGODB_URI_TESTE)).toMatchObject({ ok: true, valor: { ambiente: "teste", modo: "apply" } });
    });

    it("execução fora da máquina do operador é recusada: artefato compilado, NODE_ENV=production, Render, container", async () => {
      const base = EXECUCAO_LOCAL;
      await recusado(ARGS_DRY_RUN, { execucao: { ...base, arquivoDeEntrada: "/app/dist/scripts/migrar-midias-legadas.js" } }, "artefato compilado");
      await recusado(ARGS_DRY_RUN, { execucao: { ...base, variaveis: { NODE_ENV: "production" } } }, "NODE_ENV=production");
      await recusado(ARGS_APPLY, { execucao: { ...base, variaveis: { RENDER_SERVICE_ID: "srv-1" } } }, "Render");
      await recusado(ARGS_APPLY, { execucao: { ...base, existeArquivo: (caminho) => caminho === "/.dockerenv" } }, "container Docker");
    });
  });

  describe("integração — contexto real do comando em mariela_test", () => {
    let connection: Connection;
    let sequencia = 0;

    interface MidiaCrua {
      _id: string;
      tipo: string;
      url: string;
      chave: string | null;
      origem: string;
      ordem: number;
      varianteId: Types.ObjectId | null;
    }
    interface ProdutoCru {
      _id: Types.ObjectId;
      __v: number;
      codProduto: string;
      variantes: { _id: Types.ObjectId; foto: unknown; video: unknown }[];
      fotoPrincipalVarianteId: Types.ObjectId | null;
      atualizadoEm: Date;
      midias?: MidiaCrua[];
      midiaPrincipalId?: string | null;
    }
    const produtos = () => connection.collection<ProdutoCru>("produtos");

    beforeAll(async () => {
      connection = await createConnection(MONGODB_URI_TESTE).asPromise();
    });
    beforeEach(async () => {
      await connection.collection("produtos").deleteMany({});
    });
    afterAll(async () => {
      await connection.collection("produtos").deleteMany({});
      await connection.close();
    });

    /** Produto no formato ANTIGO (sem `midias`/`midiaPrincipalId`), direto na coleção. */
    async function produtoLegado(variantes: { foto?: unknown; video?: unknown }[], extra: Record<string, unknown> = {}) {
      sequencia += 1;
      const _id = new Types.ObjectId();
      const varianteIds = variantes.map(() => new Types.ObjectId());
      await connection.collection("produtos").insertOne({
        _id,
        __v: 0,
        codProduto: `MIG-${sequencia}`,
        nome: `Produto Migração ${sequencia}`,
        descricao: "",
        categoria: "Vestidos",
        colecaoId: null,
        campanhaId: null,
        fornecedorId: null,
        precoCusto: 50,
        precoVenda: 100,
        margemLucro: 50,
        ehNovidade: false,
        ehPromocao: false,
        precoPromocional: null,
        quantidadeTotal: 0,
        fotoPrincipalVarianteId: null,
        estoqueZeradoEm: null,
        excluidoEm: null,
        variantes: variantes.map((variante, indice) => ({
          _id: varianteIds[indice],
          cor: `Cor ${indice}`,
          corNormalizada: `cor ${indice}`,
          codVariante: `MIG-${sequencia}-${indice}`,
          quantidadeVariante: 0,
          foto: variante.foto ?? null,
          video: variante.video ?? null,
          tamanhos: [],
        })),
        criadoEm: new Date("2026-01-01T00:00:00.000Z"),
        atualizadoEm: new Date("2026-01-02T00:00:00.000Z"),
        ...extra,
      });
      return { id: _id, idTexto: _id.toHexString(), codProduto: `MIG-${sequencia}`, varianteIds };
    }

    async function todos(): Promise<ProdutoCru[]> {
      return produtos().find({}).sort({ _id: 1 }).toArray();
    }
    async function um(id: Types.ObjectId): Promise<ProdutoCru> {
      const doc = await produtos().findOne({ _id: id });
      if (!doc) throw new Error("produto não encontrado");
      return doc;
    }
    /** Tudo o que NÃO é galeria — tem de continuar idêntico, byte a byte (BSON), depois do --apply. */
    function semGaleria(doc: ProdutoCru): Uint8Array {
      const { midias: _m, midiaPrincipalId: _p, __v: _v, ...resto } = doc;
      return mongo.BSON.serialize(resto);
    }

    /** Cenário usado nos testes de dry-run/apply. */
    async function cenario() {
      const completo = await produtoLegado([
        { foto: "https://cdn.externo.com/a.jpg", video: "https://cdn.externo.com/a.mp4" },
        { foto: "https://cdn.externo.com/b.jpg" },
        {},
      ]);
      await produtos().updateOne({ _id: completo.id }, { $set: { fotoPrincipalVarianteId: completo.varianteIds[1]! } });
      const r2 = await produtoLegado([{}]);
      await produtos().updateOne({ _id: r2.id }, { $set: { "variantes.0.foto": `${BASE}/products/${r2.idTexto}/${UUID_A}.jpg` } });
      const comInvalida = await produtoLegado([{ foto: "nao-e-url" }, { foto: "https://x.com/ok.jpg" }]);
      const semMidia = await produtoLegado([{}, {}]);
      const acimaDoLimite = await produtoLegado(Array.from({ length: 21 }, (_, i) => ({ foto: `https://x.com/limite-${i}.jpg` })));
      const principalSemFoto = await produtoLegado([{ video: "https://x.com/v.mp4" }, { foto: "https://x.com/p.jpg" }]);
      await produtos().updateOne({ _id: principalSemFoto.id }, { $set: { fotoPrincipalVarianteId: principalSemFoto.varianteIds[0]! } });
      const comGaleria = await produtoLegado([{ foto: "https://x.com/legado.jpg" }], {
        midias: [{ _id: "upload-novo-1", tipo: "image", chave: `products/x/${UUID_A}.jpg`, url: `${BASE}/products/x/${UUID_A}.jpg`, contentType: "image/jpeg", tamanho: 10, nomeOriginal: "u.jpg", origem: "upload", varianteId: null, ordem: 0, criadoEm: new Date(), criadoPor: "admin" }],
        midiaPrincipalId: "upload-novo-1",
      });
      const conflito = await produtoLegado([{ foto: "https://x.com/repetida.jpg" }], {
        midias: [{ _id: "upload-novo-2", tipo: "image", chave: null, url: "https://x.com/repetida.jpg", contentType: null, tamanho: null, nomeOriginal: null, origem: "upload", varianteId: null, ordem: 0, criadoEm: new Date(), criadoPor: null }],
        midiaPrincipalId: null,
      });
      return { completo, r2, comInvalida, semMidia, acimaDoLimite, principalSemFoto, comGaleria, conflito };
    }

    /** Comandos do protocolo que alteram dados, índices ou coleções. */
    const COMANDOS_DE_ESCRITA = ["insert", "update", "delete", "findAndModify", "createIndexes", "dropIndexes", "create", "drop", "dropDatabase", "renameCollection", "collMod", "bulkWrite"];
    const COMANDOS_DE_LEITURA_ACEITOS = new Set(["find", "getMore", "killCursors", "endSessions"]);
    const METODOS_MONGOOSE_DE_INDICE_OU_ESCRITA = ["createIndex", "createIndexes", "ensureIndexes", "syncIndexes", "dropIndex", "dropIndexes", "createCollection", "insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "findOneAndUpdate", "deleteOne", "deleteMany", "bulkWrite"];
    type EventoDeComando = { commandName: string; command: Record<string, unknown> };
    function novaInstrumentacao() {
      const destino = { comandos: [] as EventoDeComando[], metodos: [] as string[], conexoes: [] as Connection[] };
      const aoConectar = (conexao: Connection) => {
        destino.conexoes.push(conexao);
        conexao.set("debug", (_colecao: string, metodo: string) => {
          destino.metodos.push(metodo);
        });
        conexao.getClient().on("commandStarted", (evento: EventoDeComando) => destino.comandos.push({ commandName: evento.commandName, command: evento.command }));
      };
      return { destino, abrir: criarAbridorDeContexto({ aoConectar }) };
    }

    it("dry-run: nenhum comando de escrita ou de índice (driver e Mongoose), documentos intactos, relatório explícito, conexão encerrada", async () => {
      const ids = await cenario();
      const antes = await todos();
      const uploadsAntes = await connection.collection("uploads_midia").countDocuments();
      const { destino, abrir } = novaInstrumentacao();

      const { codigo, texto } = await executar(ARGS_DRY_RUN, abrir);

      expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
      expect(texto).toContain("Modo: dry-run (somente leitura — nada será alterado)");
      expect(texto).toContain("Resumo — PREVISÃO do dry-run (NENHUM dado foi alterado):");
      expect(texto).toContain(`[MIGRARIA] produto ${ids.completo.idTexto} (${ids.completo.codProduto}): 2 imagem(ns), 1 vídeo(s), principal definida`);
      expect(texto).toContain("Produtos analisados: 8");

      const nomes = destino.comandos.map((evento) => evento.commandName);
      expect(nomes).toContain("find");
      expect(nomes.filter((nome) => COMANDOS_DE_ESCRITA.includes(nome))).toEqual([]);
      expect(nomes.filter((nome) => !COMANDOS_DE_LEITURA_ACEITOS.has(nome))).toEqual([]);
      expect(destino.metodos.filter((metodo) => METODOS_MONGOOSE_DE_INDICE_OU_ESCRITA.includes(metodo))).toEqual([]);

      expect(await todos()).toEqual(antes);
      expect(await connection.collection("uploads_midia").countDocuments()).toBe(uploadsAntes);
      expect(destino.conexoes).toHaveLength(1);
      expect(destino.conexoes[0]?.readyState).toBe(0);
      expect(texto).not.toContain("mongodb://");
    });

    it("--apply: migra conforme as regras, preserva byte a byte tudo que não é galeria, não toca uploads_midia nem índices", async () => {
      const ids = await cenario();
      const antes = new Map((await todos()).map((doc) => [doc._id.toHexString(), doc]));
      const uploadsAntes = await connection.collection("uploads_midia").countDocuments();
      const { destino, abrir } = novaInstrumentacao();

      const { codigo, texto } = await executar(ARGS_APPLY, abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria); // URL inválida, limite, principal sem foto, conflito

      // Tudo que não é galeria (campos legados, atualizadoEm, variantes...) idêntico byte a byte, em TODOS os produtos.
      for (const depois of await todos()) expect(semGaleria(depois)).toEqual(semGaleria(antes.get(depois._id.toHexString())!));

      // Produto completo: fotos com a variante, vídeo do produto, ordem das variantes, principal convertida.
      const completo = await um(ids.completo.id);
      const [v0, v1] = ids.completo.varianteIds;
      expect(completo.midias!.map((m) => [m._id, m.tipo, m.ordem, m.origem, m.chave, m.varianteId === null ? null : String(m.varianteId)])).toEqual([
        [idMidiaLegada(ids.completo.idTexto, String(v0), "foto"), "image", 0, "legado", null, String(v0)],
        [idMidiaLegada(ids.completo.idTexto, String(v0), "video"), "video", 1, "legado", null, null],
        [idMidiaLegada(ids.completo.idTexto, String(v1), "foto"), "image", 2, "legado", null, String(v1)],
      ]);
      expect(completo.midiaPrincipalId).toBe(idMidiaLegada(ids.completo.idTexto, String(v1), "foto"));
      expect(completo.__v).toBe(1);
      expect(urlImagemPrincipalDaGaleria({ midias: completo.midias!, midiaPrincipalId: completo.midiaPrincipalId ?? null })).toBe("https://cdn.externo.com/b.jpg");

      expect((await um(ids.r2.id)).midias![0]!.chave).toBe(`products/${ids.r2.idTexto}/${UUID_A}.jpg`);
      expect((await um(ids.comInvalida.id)).midias!.map((m) => m.url)).toEqual(["https://x.com/ok.jpg"]);
      expect((await um(ids.semMidia.id)).midias).toBeUndefined();
      const principalSemFoto = await um(ids.principalSemFoto.id);
      expect(principalSemFoto.midias).toHaveLength(2);
      // Nenhuma principal inventada: o campo continua ausente (lido como null pelo default do schema).
      expect(principalSemFoto.midiaPrincipalId ?? null).toBeNull();
      // Galeria nova: legado combinado depois, principal existente preservada.
      const comGaleria = await um(ids.comGaleria.id);
      expect(comGaleria.midias!.map((m) => [m._id, m.ordem])).toEqual([["upload-novo-1", 0], [idMidiaLegada(ids.comGaleria.idTexto, String(ids.comGaleria.varianteIds[0]), "foto"), 1]]);
      expect(comGaleria.midiaPrincipalId).toBe("upload-novo-1");
      // Pendentes: produto INTACTO (inclusive __v).
      for (const pendente of [ids.acimaDoLimite, ids.conflito]) expect(await um(pendente.id)).toEqual(antes.get(pendente.idTexto)!);

      expect(texto).toContain("Produtos migrados: 5");
      expect(texto).toContain("Produtos sem mídia: 1");
      // Imagens: completo 2 + r2 1 + comInvalida 1 + principalSemFoto 1 + comGaleria 1; vídeos: completo 1 + principalSemFoto 1.
      expect(texto).toContain("Imagens migradas: 6");
      expect(texto).toContain("Vídeos migrados: 2");
      expect(texto).toContain("URLs externas preservadas (chave null): 7");
      expect(texto).toContain("Chaves R2 identificadas: 1");
      expect(texto).toContain("Produtos acima dos limites: 1");
      expect(texto).toContain("Conflitos com galerias existentes: 1");
      expect(texto).toContain("URLs inválidas: 1");
      expect(texto).toContain("Principais sem imagem correspondente: 1");
      expect(texto).toContain("Produtos pendentes: 4");

      expect(await connection.collection("uploads_midia").countDocuments()).toBe(uploadsAntes);
      const nomes = destino.comandos.map((evento) => evento.commandName);
      expect(nomes).toContain("update");
      expect(nomes.filter((nome) => ["insert", "delete", "findAndModify", "createIndexes", "dropIndexes", "create", "drop", "collMod"].includes(nome))).toEqual([]);
      // Os updates só tocam galeria e versão — nunca os campos legados nem atualizadoEm.
      for (const evento of destino.comandos.filter((e) => e.commandName === "update")) {
        const atualizacoes = (evento.command["updates"] as { u: Record<string, Record<string, unknown>> }[]).map((item) => item.u);
        for (const u of atualizacoes) {
          const campos = Object.values(u).flatMap((operador) => Object.keys(operador));
          expect(campos.every((campo) => ["midias", "midiaPrincipalId", "__v"].includes(campo))).toBe(true);
        }
      }
      expect(destino.conexoes[0]?.readyState).toBe(0);
    });

    it("idempotência: a segunda aplicação não muda nada e relata os produtos como já migrados; o dry-run depois prevê zero migrações", async () => {
      await cenario();
      await executar(ARGS_APPLY, abrirContextoDoComando);
      const depoisDaPrimeira = await todos();

      const segunda = await executar(ARGS_APPLY, abrirContextoDoComando);
      expect(segunda.texto).toContain("Produtos migrados: 0");
      expect(segunda.texto).toContain("Produtos já migrados: 5");
      expect(await todos()).toEqual(depoisDaPrimeira);

      const previsao = await executar(ARGS_DRY_RUN, abrirContextoDoComando);
      expect(previsao.texto).toContain("Produtos que seriam migrados: 0");
      expect(previsao.texto).toContain("Produtos já migrados: 5");
    });

    it("falha de escrita num produto: ele fica pendente e intacto, os demais migram, o erro não expõe a URI", async () => {
      const alvo = await produtoLegado([{ foto: "https://x.com/falha.jpg" }]);
      const outro = await produtoLegado([{ foto: "https://x.com/ok.jpg" }]);
      const antes = await um(alvo.id);
      const abrir: AbrirContexto = async (uri) => {
        const real = await abrirContextoDoComando(uri);
        const migrador: ContextoMigracao["migrador"] = {
          listarProdutos: () => real.migrador.listarProdutos(),
          lerProduto: (id) => real.migrador.lerProduto(id),
          acrescentarMidias: async (lido, novas, principal) => {
            if (lido._id.equals(alvo.id)) throw new Error(`falha simulada em ${MONGODB_URI_TESTE}`);
            return real.migrador.acrescentarMidias(lido, novas, principal);
          },
        };
        return { ...real, migrador };
      };
      const { codigo, texto } = await executar(ARGS_APPLY, abrir);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
      expect(texto).toContain(`[PENDENTE] produto ${alvo.idTexto} (${alvo.codProduto}): falha_escrita`);
      expect(texto).not.toContain("mongodb://");
      expect(await um(alvo.id)).toEqual(antes);
      expect((await um(outro.id)).midias).toHaveLength(1);
    });

    it("concorrência: documento alterado entre a leitura e a escrita → relê, replaneja e grava; alterado sempre → pendente sem gravar", async () => {
      const uma = await produtoLegado([{ foto: "https://x.com/c1.jpg" }]);
      const sempre = await produtoLegado([{ foto: "https://x.com/c2.jpg" }]);
      const chamadas = new Map<string, number>();
      const abrir: AbrirContexto = async (uri) => {
        const real = await abrirContextoDoComando(uri);
        const migrador: ContextoMigracao["migrador"] = {
          listarProdutos: () => real.migrador.listarProdutos(),
          lerProduto: (id) => real.migrador.lerProduto(id),
          acrescentarMidias: async (lido, novas, principal) => {
            const chave = lido._id.toHexString();
            const vez = (chamadas.get(chave) ?? 0) + 1;
            chamadas.set(chave, vez);
            // Escrita concorrente real (avança o __v) logo antes da escrita condicional da migração.
            if (lido._id.equals(sempre.id) || vez === 1) await produtos().updateOne({ _id: lido._id }, { $inc: { __v: 1 } });
            return real.migrador.acrescentarMidias(lido, novas, principal);
          },
        };
        return { ...real, migrador };
      };
      const { texto } = await executar(ARGS_APPLY, abrir);
      expect(chamadas.get(uma.idTexto)).toBe(2);
      expect((await um(uma.id)).midias).toHaveLength(1);
      expect(chamadas.get(sempre.idTexto)).toBe(3);
      expect((await um(sempre.id)).midias).toBeUndefined();
      expect(texto).toContain(`[PENDENTE] produto ${sempre.idTexto}`);
      expect(texto).toContain("concorrencia");
    });

    it("produto já migrado do qual uma mídia legada foi removida da galeria: pendente, nunca reinserida", async () => {
      const produto = await produtoLegado([{ foto: "https://x.com/r1.jpg" }, { foto: "https://x.com/r2.jpg" }]);
      await executar(ARGS_APPLY, abrirContextoDoComando);
      const removida = idMidiaLegada(produto.idTexto, String(produto.varianteIds[0]), "foto");
      await produtos().updateOne({ _id: produto.id }, { $pull: { midias: { _id: removida } }, $inc: { __v: 1 } });
      const antes = await um(produto.id);
      const { texto } = await executar(ARGS_APPLY, abrirContextoDoComando);
      expect(texto).toContain("divergencia_pos_migracao");
      expect(await um(produto.id)).toEqual(antes);
    });

    it("o abridor padrão (o do ponto de entrada) funciona em mariela_test e o relatório não expõe a URI", async () => {
      await produtoLegado([{ foto: "https://x.com/padrao.jpg" }]);
      const { codigo, texto } = await executar(ARGS_DRY_RUN, abrirContextoDoComando);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(texto).toContain("Produtos que seriam migrados: 1");
      expect(texto).not.toContain(MONGODB_URI_TESTE);
    });
  });
});
