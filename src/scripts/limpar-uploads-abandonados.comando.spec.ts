import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createConnection, Types, type Connection } from "mongoose";
import { liberarTudo, novoPonto, type PontoDeParada } from "../test-utils/barreira.util.js";
import { arquivoDoFormato, MediaStorageFalso } from "../test-utils/media-storage-falso.util.js";
import { MONGODB_URI_TESTE } from "../test-utils/mongo-teste.util.js";
import type { AmbienteDeExecucao } from "./comando-local.util.js";
import {
  abrirContextoDoComando,
  CODIGOS_DE_SAIDA,
  criarAbridorDeContexto,
  executarComando,
  lerConfigR2,
  MARGEM_DE_SEGURANCA_MS,
  validarAmbiente,
  type AbrirContexto,
  type ConfigR2,
  type ContextoLimpeza,
} from "./limpar-uploads-abandonados.comando.js";

/**
 * Fase 60.3 — comando `limpar-uploads-abandonados`.
 * - Proteções: toda recusa acontece ANTES de conectar.
 * - Integração: contexto REAL do comando em `mariela_test` (único banco usado), com o storage FALSO no lugar do R2
 *   (nenhum teste fala com o R2) e instrumentação do driver para provar o que é enviado ao MongoDB.
 */

const BANCO = "mariela_test";
const ARGS_DRY_RUN = ["--banco", BANCO];
const ARGS_APPLY = ["--banco", BANCO, "--apply"];
const URI_PRODUCAO = "mongodb+srv://usuario_app:SenhaSecretaDoAtlas123@cluster0.exemplo.mongodb.net/marielaDB?retryWrites=true&w=majority";
const AGORA = new Date("2026-11-04T12:00:00.000Z");
/** Credenciais FICTÍCIAS: só habilitam o --apply; o storage usado nos testes é sempre o falso. */
const R2_FICTICIO: ConfigR2 = { accountId: "conta", accessKeyId: "AKIAFICTICIO", secretAccessKey: "segredo-ficticio-r2", bucketName: "bucket", publicBaseUrl: "https://media.exemplo.com" };
const EXECUCAO_LOCAL: AmbienteDeExecucao = {
  arquivoDeEntrada: fileURLToPath(new URL("./limpar-uploads-abandonados.ts", import.meta.url)),
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
  uri?: string | null;
  r2?: ConfigR2 | null;
  execucao?: AmbienteDeExecucao;
}

async function executar(argv: string[], abrir: AbrirContexto, opcoes: OpcoesExecucao = {}) {
  const saida: string[] = [];
  const uri = opcoes.uri === undefined ? MONGODB_URI_TESTE : opcoes.uri;
  const codigo = await executarComando({
    argv,
    uri: uri ?? undefined,
    r2: opcoes.r2 === undefined ? R2_FICTICIO : opcoes.r2,
    escrever: (linha) => saida.push(linha),
    abrirContexto: abrir,
    execucao: opcoes.execucao ?? EXECUCAO_LOCAL,
    agora: () => AGORA,
  });
  return { codigo, texto: saida.join("\n") };
}

describe("comando limpar-uploads-abandonados (Fase 60.3)", () => {
  describe("proteção de ambiente — recusas ANTES de qualquer conexão", () => {
    async function recusado(argv: string[], opcoes: OpcoesExecucao, trecho: string) {
      const abridor = abridorQueNaoConecta();
      const { codigo, texto } = await executar(argv, abridor.abrir, opcoes);
      expect(codigo).toBe(CODIGOS_DE_SAIDA.recusado);
      expect(texto).toContain(trecho);
      expect(abridor.chamadas).toEqual([]);
      for (const segredo of ["SenhaSecretaDoAtlas123", "segredo-ficticio-r2", "mongodb://", "mongodb+srv://"]) expect(texto).not.toContain(segredo);
    }

    it("--banco obrigatório; parâmetros desconhecidos (sem opção de contorno) e valores livres não ecoados", async () => {
      await recusado([], {}, "é obrigatório");
      await recusado([...ARGS_APPLY, "--confirmar-producao", "marielaDB"], {}, 'Parâmetro desconhecido "--confirmar-producao"');
      await recusado([...ARGS_APPLY, "--forcar"], {}, 'Parâmetro desconhecido "--forcar"');
      await recusado(["--banco", BANCO, URI_PRODUCAO], {}, "(valor não exibido)");
    });

    it("banco de desenvolvimento, banco divergente da URI e URI ausente são recusados", async () => {
      await recusado(["--banco", "mariela_dev_local"], {}, "recusado por este comando");
      await recusado(["--banco", "outro"], {}, "é diferente do banco da MONGODB_URI");
      await recusado(ARGS_DRY_RUN, { uri: null }, "MONGODB_URI não está definida");
    });

    it("--apply só no mariela_test local: produção local, Atlas/Render e host remoto são recusados", async () => {
      await recusado(["--banco", "marielaDB", "--apply"], { uri: "mongodb://127.0.0.1:27017/marielaDB" }, "Limpeza recusada");
      await recusado(["--banco", "marielaDB", "--apply"], { uri: URI_PRODUCAO }, "conexão externa (Atlas/Render ou host remoto)");
      await recusado(ARGS_APPLY, { uri: "mongodb://db.remoto.exemplo.com:27017/mariela_test" }, "conexão externa");
    });

    it("--apply sem o storage configurado é recusado; o dry-run segue autorizado (inclusive em banco protegido, só leitura)", async () => {
      await recusado(ARGS_APPLY, { r2: null }, "exige o storage configurado");
      expect(validarAmbiente({ banco: BANCO, aplicar: false }, MONGODB_URI_TESTE, null)).toMatchObject({ ok: true, valor: { modo: "dry-run" } });
      expect(validarAmbiente({ banco: "marielaDB", aplicar: false }, URI_PRODUCAO, null)).toMatchObject({ ok: true, valor: { ambiente: "protegido" } });
    });

    it("execução fora da máquina do operador é recusada: artefato compilado, NODE_ENV=production, Render, container", async () => {
      await recusado(ARGS_DRY_RUN, { execucao: { ...EXECUCAO_LOCAL, arquivoDeEntrada: "/app/dist/scripts/limpar-uploads-abandonados.js" } }, "artefato compilado");
      await recusado(ARGS_APPLY, { execucao: { ...EXECUCAO_LOCAL, variaveis: { NODE_ENV: "production" } } }, "NODE_ENV=production");
      await recusado(ARGS_APPLY, { execucao: { ...EXECUCAO_LOCAL, variaveis: { RENDER: "true" } } }, "Render");
      await recusado(ARGS_APPLY, { execucao: { ...EXECUCAO_LOCAL, existeArquivo: (caminho) => caminho === "/.dockerenv" } }, "container Docker");
    });

    it("lerConfigR2 exige as 5 variáveis (normaliza a base pública)", () => {
      const variaveis = {
        R2_ACCOUNT_ID: "a",
        R2_ACCESS_KEY_ID: "b",
        R2_SECRET_ACCESS_KEY: "c",
        R2_BUCKET_NAME: "d",
        R2_PUBLIC_BASE_URL: "https://m.exemplo.com/",
      };
      expect(lerConfigR2(variaveis)).toEqual({ accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucketName: "d", publicBaseUrl: "https://m.exemplo.com" });
      expect(lerConfigR2({ ...variaveis, R2_BUCKET_NAME: " " })).toBeNull();
    });
  });

  describe("integração — contexto real do comando em mariela_test, storage falso", () => {
    let connection: Connection;
    const storage = new MediaStorageFalso();

    interface UploadCru {
      _id: string;
      produtoId: Types.ObjectId;
      chave: string;
      estado: string;
      limpezaApos: Date;
      [campo: string]: unknown;
    }
    const uploads = () => connection.collection<UploadCru>("uploads_midia");
    interface MidiaCrua {
      _id: string;
      tipo: string;
      chave: string | null;
      url: string;
      ordem: number;
      origem?: string;
      varianteId?: null;
    }
    const produtos = () => connection.collection<{ _id: Types.ObjectId; midias: MidiaCrua[] }>("produtos");

    beforeAll(async () => {
      connection = await createConnection(MONGODB_URI_TESTE).asPromise();
    });
    beforeEach(async () => {
      storage.reiniciar();
      await connection.collection("uploads_midia").deleteMany({});
      await connection.collection("produtos").deleteMany({});
    });
    afterAll(async () => {
      await connection.collection("uploads_midia").deleteMany({});
      await connection.collection("produtos").deleteMany({});
      await connection.close();
    });

    async function produto(midias: Record<string, unknown>[] = [], variantes: Record<string, unknown>[] = []): Promise<Types.ObjectId> {
      const _id = new Types.ObjectId();
      await connection.collection("produtos").insertOne({ _id, __v: 0, codProduto: `LIMP-${_id.toHexString()}`, excluidoEm: null, variantes, midias, midiaPrincipalId: null });
      return _id;
    }

    type Prazo = "vencido" | "margem" | "futuro";
    const LIMPEZA: Record<Prazo, Date> = {
      vencido: new Date(AGORA.getTime() - MARGEM_DE_SEGURANCA_MS - 60 * 60 * 1000),
      margem: new Date(AGORA.getTime() - MARGEM_DE_SEGURANCA_MS / 3),
      futuro: new Date(AGORA.getTime() + 60 * 60 * 1000),
    };

    /** Registro de upload cru (mesmo formato gravado pela galeria) e, opcionalmente, o objeto no storage falso. */
    async function registro(produtoId: Types.ObjectId, estado = "pendente", prazo: Prazo = "vencido", comObjeto = true) {
      const uploadId = randomUUID();
      const chave = `products/${produtoId.toHexString()}/${uploadId}.jpg`;
      await uploads().insertOne({
        _id: uploadId,
        produtoId,
        chave,
        tipo: "image",
        contentType: "image/jpeg",
        tamanho: 1024,
        nomeOriginal: "foto.jpg",
        substituiMidiaId: null,
        estado,
        criadoPor: null,
        criadoEm: new Date(LIMPEZA[prazo].getTime() - 24 * 60 * 60 * 1000),
        urlExpiraEm: new Date(LIMPEZA[prazo].getTime() - 23 * 60 * 60 * 1000),
        limpezaApos: LIMPEZA[prazo],
        confirmadoEm: null,
        removidoEm: null,
      });
      if (comObjeto) storage.enviar(chave, arquivoDoFormato("image/jpeg"), "image/jpeg");
      return { uploadId, chave };
    }
    async function estado(uploadId: string): Promise<string | undefined> {
      return (await uploads().findOne({ _id: uploadId }))?.estado;
    }

    /** Contexto real (conexão própria, sem índices) com o storage falso no lugar do R2. */
    function abrirComStorageFalso(opcoes: { aoConectar?: (conexao: Connection) => void; ajustar?: (contexto: ContextoLimpeza) => ContextoLimpeza } = {}): AbrirContexto {
      const base = criarAbridorDeContexto({ aoConectar: opcoes.aoConectar });
      return async (uri, r2) => {
        const real = await base(uri, r2);
        const contexto: ContextoLimpeza = { ...real, storage };
        return opcoes.ajustar ? opcoes.ajustar(contexto) : contexto;
      };
    }
    type EventoDeComando = { commandName: string; command: Record<string, unknown> };
    function instrumentacao() {
      const comandos: EventoDeComando[] = [];
      const conexoes: Connection[] = [];
      const aoConectar = (conexao: Connection) => {
        conexoes.push(conexao);
        conexao.getClient().on("commandStarted", (evento: EventoDeComando) => comandos.push({ commandName: evento.commandName, command: evento.command }));
      };
      return { comandos, conexoes, aoConectar };
    }
    const COMANDOS_DE_ESCRITA = ["insert", "update", "delete", "findAndModify", "createIndexes", "dropIndexes", "create", "drop", "dropDatabase", "renameCollection", "collMod", "bulkWrite"];

    /** Um registro de cada situação. */
    async function cenario() {
      const dono = await produto();
      const comObjeto = await registro(dono);
      const semObjeto = await registro(dono, "pendente", "vencido", false);
      const futuro = await registro(dono, "pendente", "futuro");
      const naMargem = await registro(dono, "pendente", "margem");
      const confirmado = await registro(dono, "confirmado");
      const removido = await registro(dono, "removido");
      const descartado = await registro(dono, "descartado");
      const refId = await registro(dono);
      const refChave = await registro(dono);
      await produtos().updateOne(
        { _id: dono },
        {
          $push: {
            midias: {
              $each: [
                { _id: refId.uploadId, tipo: "image", chave: null, url: "https://x/a.jpg", origem: "upload", varianteId: null, ordem: 0 },
                { _id: "outro-id", tipo: "image", chave: refChave.chave, url: "https://x/b.jpg", origem: "legado", varianteId: null, ordem: 1 },
              ],
            },
          },
        },
      );
      return { comObjeto, semObjeto, futuro, naMargem, confirmado, removido, descartado, refId, refChave };
    }

    it("dry-run: só leituras no MongoDB, nenhuma exclusão no storage, registros intactos, relatório explícito", async () => {
      const r = await cenario();
      const antes = await uploads().find({}).sort({ _id: 1 }).toArray();
      const inst = instrumentacao();
      const { codigo, texto } = await executar(ARGS_DRY_RUN, abrirComStorageFalso({ aoConectar: inst.aoConectar }));

      expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria); // 2 preservados por referência
      expect(texto).toContain("Resumo — PREVISÃO do dry-run (NENHUMA escrita no MongoDB nem no storage):");
      expect(texto).toContain(`[SERIA_EXCLUIDO] upload ${r.comObjeto.uploadId}`);
      expect(texto).toContain(`[SERIA_DESCARTADO_AUSENTE] upload ${r.semObjeto.uploadId}`);
      expect(texto).toContain(`[PRESERVADO_REFERENCIA] upload ${r.refId.uploadId}`);
      expect(texto).toContain(`[PRESERVADO_REFERENCIA] upload ${r.refChave.uploadId}`);
      for (const linha of [
        "Registros analisados: 9",
        "Fora do escopo (confirmado, removido ou descartado — nunca tocados): 3",
        "Pendentes não expirados: 1",
        "dentro da margem de segurança (15 min): 1",
        "Registros elegíveis: 4",
        "Objetos existentes: 1",
        "Objetos já ausentes: 1",
        "Objetos que seriam excluídos: 1",
        "Objetos efetivamente excluídos: 0",
        "Registros preservados por referência: 2",
        "Dry-run: nenhuma escrita ocorreu no MongoDB nem no storage.",
      ]) {
        expect(texto).toContain(linha);
      }

      expect(inst.comandos.map((e) => e.commandName).filter((nome) => COMANDOS_DE_ESCRITA.includes(nome))).toEqual([]);
      expect(storage.exclusoes).toEqual([]);
      expect(await uploads().find({}).sort({ _id: 1 }).toArray()).toEqual(antes);
      expect(inst.conexoes[0]?.readyState).toBe(0);
    });

    it("--apply: exclui só os abandonados não referenciados e os marca descartado; todo o resto intacto; nenhum registro apagado; sem índices", async () => {
      const r = await cenario();
      const totalAntes = await uploads().countDocuments();
      const inst = instrumentacao();
      const { codigo, texto } = await executar(ARGS_APPLY, abrirComStorageFalso({ aoConectar: inst.aoConectar }));

      expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria); // preservados por referência
      expect(storage.exclusoes).toEqual([r.comObjeto.chave]);
      expect(await estado(r.comObjeto.uploadId)).toBe("descartado");
      expect(await estado(r.semObjeto.uploadId)).toBe("descartado");
      for (const intacto of [r.futuro, r.naMargem, r.refId, r.refChave]) {
        expect(await estado(intacto.uploadId)).toBe("pendente");
        expect(storage.objetos.has(intacto.chave)).toBe(true);
      }
      for (const [item, esperado] of [[r.confirmado, "confirmado"], [r.removido, "removido"], [r.descartado, "descartado"]] as const) {
        expect(await estado(item.uploadId)).toBe(esperado);
        expect(storage.objetos.has(item.chave)).toBe(true);
      }
      expect(await uploads().countDocuments()).toBe(totalAntes);
      expect(texto).toContain("Objetos efetivamente excluídos: 1");
      expect(texto).toContain("Registros marcados como descartados: 2");

      const escritas = inst.comandos.filter((e) => COMANDOS_DE_ESCRITA.includes(e.commandName));
      expect(escritas.map((e) => [e.commandName, e.command["update"]])).toEqual([
        ["update", "uploads_midia"],
        ["update", "uploads_midia"],
      ]);
      // A marcação é condicional ao estado ainda ser pendente.
      for (const evento of escritas) {
        const [atualizacao] = evento.command["updates"] as { q: Record<string, unknown>; u: Record<string, unknown> }[];
        expect(atualizacao?.q["estado"]).toBe("pendente");
        expect(atualizacao?.u).toEqual({ $set: { estado: "descartado" } });
      }
    });

    it("referência legada (variante.foto) ou foto histórica de venda preserva o objeto", async () => {
      const dono = await produto();
      const legado = await registro(dono);
      const vendido = await registro(dono);
      await produto([], [{ _id: new Types.ObjectId(), foto: `https://media.exemplo.com/${legado.chave}`, video: null }]);
      const vendaId = new Types.ObjectId();
      await connection.collection("vendas").insertOne({ _id: vendaId, itens: [{ foto: `https://media.exemplo.com/${vendido.chave}` }] });
      try {
        const { texto } = await executar(ARGS_APPLY, abrirComStorageFalso());
        expect(texto).toContain(`[PRESERVADO_REFERENCIA] upload ${legado.uploadId}`);
        expect(texto).toContain(`venda ${vendaId.toHexString()}`);
        expect(storage.exclusoes).toEqual([]);
        expect(await estado(legado.uploadId)).toBe("pendente");
        expect(await estado(vendido.uploadId)).toBe("pendente");
      } finally {
        await connection.collection("vendas").deleteOne({ _id: vendaId });
      }
    });

    it("produto inexistente (consulta bem-sucedida, sem documento): limpa e relata", async () => {
      const r = await registro(new Types.ObjectId());
      const { texto } = await executar(ARGS_APPLY, abrirComStorageFalso());
      expect(storage.exclusoes).toEqual([r.chave]);
      expect(await estado(r.uploadId)).toBe("descartado");
      expect(texto).toContain("produto inexistente");
    });

    it("falha de leitura do produto ou das referências: nada excluído, registro pendente", async () => {
      const r = await registro(await produto());
      for (const metodo of ["produtoExiste", "buscarReferencia"] as const) {
        const { texto } = await executar(
          ARGS_APPLY,
          abrirComStorageFalso({
            ajustar: (contexto) => ({
              ...contexto,
              leitor: {
                listarRegistros: () => contexto.leitor.listarRegistros(),
                lerRegistro: (id) => contexto.leitor.lerRegistro(id),
                produtoExiste: (id) => (metodo === "produtoExiste" ? Promise.reject(new Error(`falha simulada ${MONGODB_URI_TESTE}`)) : contexto.leitor.produtoExiste(id)),
                buscarReferencia: (id, chave) => (metodo === "buscarReferencia" ? Promise.reject(new Error("falha simulada")) : contexto.leitor.buscarReferencia(id, chave)),
                marcarDescartado: (id) => contexto.leitor.marcarDescartado(id),
              },
            }),
          }),
        );
        expect(texto).toContain(`[FALHA_CONSULTA] upload ${r.uploadId}`);
        expect(texto).not.toContain("mongodb://");
      }
      expect(storage.exclusoes).toEqual([]);
      expect(await estado(r.uploadId)).toBe("pendente");
    });

    it("falha ao consultar o storage e falha na exclusão: registro mantido pendente, objeto preservado", async () => {
      const r = await registro(await produto());
      storage.falhas.inspecionar = true;
      expect((await executar(ARGS_APPLY, abrirComStorageFalso())).texto).toContain(`[FALHA_LEITURA_STORAGE] upload ${r.uploadId}`);
      storage.falhas.inspecionar = false;
      storage.falhas.excluir = true;
      const { codigo, texto } = await executar(ARGS_APPLY, abrirComStorageFalso());
      expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
      expect(texto).toContain(`[FALHA_EXCLUSAO] upload ${r.uploadId}`);
      expect(storage.objetos.has(r.chave)).toBe(true);
      expect(await estado(r.uploadId)).toBe("pendente");
    });

    it("falha ao marcar descartado depois da exclusão: registro fica pendente e a próxima execução conclui (objeto já ausente)", async () => {
      const r = await registro(await produto());
      const primeira = await executar(
        ARGS_APPLY,
        abrirComStorageFalso({
          ajustar: (contexto) => ({
            ...contexto,
            leitor: {
              listarRegistros: () => contexto.leitor.listarRegistros(),
              lerRegistro: (id) => contexto.leitor.lerRegistro(id),
              produtoExiste: (id) => contexto.leitor.produtoExiste(id),
              buscarReferencia: (id, chave) => contexto.leitor.buscarReferencia(id, chave),
              marcarDescartado: () => Promise.reject(new Error("falha simulada do MongoDB")),
            },
          }),
        }),
      );
      expect(primeira.texto).toContain(`[FALHA_ATUALIZACAO] upload ${r.uploadId}`);
      expect(storage.exclusoes).toEqual([r.chave]);
      expect(await estado(r.uploadId)).toBe("pendente");

      const segunda = await executar(ARGS_APPLY, abrirComStorageFalso());
      expect(segunda.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(segunda.texto).toContain(`[DESCARTADO_AUSENTE] upload ${r.uploadId}`);
      expect(await estado(r.uploadId)).toBe("descartado");
      expect(storage.exclusoes).toEqual([r.chave]); // nada excluído de novo
    });

    /** Pausa a limpeza logo depois de verificar o objeto (antes da revalidação final e da exclusão). */
    function pausarAposInspecao(pontos: PontoDeParada[]) {
      let chamada = 0;
      return (contexto: ContextoLimpeza): ContextoLimpeza => ({
        ...contexto,
        storage: {
          inspecionarObjeto: async (chave) => {
            const resultado = await storage.inspecionarObjeto(chave);
            const ponto = pontos[chamada];
            chamada += 1;
            if (ponto) {
              ponto.chegou.liberar();
              await ponto.liberacao.promessa;
            }
            return resultado;
          },
          excluirObjeto: (chave) => storage.excluirObjeto(chave),
        },
      });
    }

    it("confirmação concorrente (registro confirmado e mídia gravada no produto durante a limpeza): nada é excluído", async () => {
      const dono = await produto();
      const r = await registro(dono);
      const ponto = novoPonto();
      try {
        const execucao = executar(ARGS_APPLY, abrirComStorageFalso({ ajustar: pausarAposInspecao([ponto]) }));
        await ponto.chegou.promessa;
        await produtos().updateOne({ _id: dono }, { $push: { midias: { _id: r.uploadId, tipo: "image", chave: r.chave, url: "https://x/c.jpg", ordem: 0 } } });
        await uploads().updateOne({ _id: r.uploadId }, { $set: { estado: "confirmado" } });
        ponto.liberacao.liberar();
        const { texto } = await execucao;
        expect(texto).toContain(`[CONFLITO] upload ${r.uploadId}`);
      } finally {
        liberarTudo(ponto);
      }
      expect(storage.exclusoes).toEqual([]);
      expect(await estado(r.uploadId)).toBe("confirmado");
    });

    it("produto recebe a mídia durante a limpeza (registro ainda pendente): preservado por referência", async () => {
      const dono = await produto();
      const r = await registro(dono);
      const ponto = novoPonto();
      try {
        const execucao = executar(ARGS_APPLY, abrirComStorageFalso({ ajustar: pausarAposInspecao([ponto]) }));
        await ponto.chegou.promessa;
        await produtos().updateOne({ _id: dono }, { $push: { midias: { _id: r.uploadId, tipo: "image", chave: r.chave, url: "https://x/d.jpg", ordem: 0 } } });
        ponto.liberacao.liberar();
        expect((await execucao).texto).toContain(`[PRESERVADO_REFERENCIA] upload ${r.uploadId}`);
      } finally {
        liberarTudo(ponto);
      }
      expect(storage.exclusoes).toEqual([]);
      expect(await estado(r.uploadId)).toBe("pendente");
    });

    it("registro removido durante a limpeza: conflito, nada excluído", async () => {
      const r = await registro(await produto());
      const ponto = novoPonto();
      try {
        const execucao = executar(ARGS_APPLY, abrirComStorageFalso({ ajustar: pausarAposInspecao([ponto]) }));
        await ponto.chegou.promessa;
        await uploads().updateOne({ _id: r.uploadId }, { $set: { estado: "removido" } });
        ponto.liberacao.liberar();
        expect((await execucao).texto).toContain(`[CONFLITO] upload ${r.uploadId}`);
      } finally {
        liberarTudo(ponto);
      }
      expect(storage.exclusoes).toEqual([]);
      expect(await estado(r.uploadId)).toBe("removido");
    });

    it("duas instâncias simultâneas no mesmo registro: o registro é descartado uma única vez e a outra relata conflito", async () => {
      const r = await registro(await produto());
      const pontos = [novoPonto(), novoPonto()];
      const ajustar = pausarAposInspecao(pontos);
      try {
        const a = executar(ARGS_APPLY, abrirComStorageFalso({ ajustar }));
        const b = executar(ARGS_APPLY, abrirComStorageFalso({ ajustar }));
        await Promise.all(pontos.map((ponto) => ponto.chegou.promessa));
        liberarTudo(...pontos);
        const textos = (await Promise.all([a, b])).map((resultado) => resultado.texto);
        expect(textos.filter((texto) => texto.includes(`[EXCLUIDO_E_DESCARTADO] upload ${r.uploadId}`) || texto.includes(`[DESCARTADO_AUSENTE] upload ${r.uploadId}`))).toHaveLength(1);
        expect(textos.filter((texto) => texto.includes(`[CONFLITO] upload ${r.uploadId}`))).toHaveLength(1);
      } finally {
        liberarTudo(...pontos);
      }
      expect(await estado(r.uploadId)).toBe("descartado");
      expect(storage.objetos.has(r.chave)).toBe(false);
    });

    it("idempotência: a segunda execução não encontra elegíveis e não exclui nada", async () => {
      await cenario();
      await executar(ARGS_APPLY, abrirComStorageFalso());
      const depois = await uploads().find({}).sort({ _id: 1 }).toArray();
      const exclusoes = [...storage.exclusoes];
      const segunda = await executar(ARGS_APPLY, abrirComStorageFalso());
      expect(segunda.texto).toContain("Objetos efetivamente excluídos: 0");
      expect(segunda.texto).toContain("Registros marcados como descartados: 0");
      expect(storage.exclusoes).toEqual(exclusoes);
      expect(await uploads().find({}).sort({ _id: 1 }).toArray()).toEqual(depois);
    });

    it("o abridor padrão sem storage configurado: dry-run marca os objetos como não verificados e nada é alterado", async () => {
      const r = await registro(await produto());
      const { codigo, texto } = await executar(ARGS_DRY_RUN, abrirContextoDoComando, { r2: null });
      expect(codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(texto).toContain(`[NAO_VERIFICADO] upload ${r.uploadId}`);
      expect(texto).toContain("Storage: não configurado");
      expect(await estado(r.uploadId)).toBe("pendente");
      expect(texto).not.toContain(MONGODB_URI_TESTE);
    });
  });
});
