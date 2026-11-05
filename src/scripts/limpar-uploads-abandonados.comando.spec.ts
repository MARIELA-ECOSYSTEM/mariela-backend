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
  PRAZO_RECUPERACAO_LIMPEZA_MS,
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
  agora?: Date;
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
    agora: () => opcoes.agora ?? AGORA,
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
      tokenReserva?: string | null;
      reservadoEm?: Date | null;
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
    const DEPOIS_DO_PRAZO_DE_RECUPERACAO = new Date(AGORA.getTime() + PRAZO_RECUPERACAO_LIMPEZA_MS + 60 * 1000);

    /** Registro de upload cru (mesmo formato gravado pela galeria) e, opcionalmente, o objeto no storage falso. */
    async function registro(produtoId: Types.ObjectId, estado = "pendente", prazo: Prazo = "vencido", comObjeto = true, reserva: { token: string; em: Date } | null = null) {
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
        tokenReserva: reserva?.token ?? null,
        reservadoEm: reserva?.em ?? null,
      });
      if (comObjeto) storage.enviar(chave, arquivoDoFormato("image/jpeg"), "image/jpeg");
      return { uploadId, chave };
    }
    async function estado(uploadId: string): Promise<string | undefined> {
      return (await uploads().findOne({ _id: uploadId }))?.estado;
    }

    type Leitor = ContextoLimpeza["leitor"];
    /** Leitor real com alguns métodos substituídos (falhas simuladas, pausas). */
    function leitorCom(real: Leitor, sobrescritas: Partial<Leitor>): Leitor {
      return {
        listarRegistros: sobrescritas.listarRegistros ?? (() => real.listarRegistros()),
        lerRegistro: sobrescritas.lerRegistro ?? ((id) => real.lerRegistro(id)),
        produtoExiste: sobrescritas.produtoExiste ?? ((id) => real.produtoExiste(id)),
        buscarReferencia: sobrescritas.buscarReferencia ?? ((id, chave) => real.buscarReferencia(id, chave)),
        assumirLimpeza: sobrescritas.assumirLimpeza ?? ((id, limite, token, agora) => real.assumirLimpeza(id, limite, token, agora)),
        recuperarLimpeza: sobrescritas.recuperarLimpeza ?? ((id, antigo, limite, token, agora) => real.recuperarLimpeza(id, antigo, limite, token, agora)),
        possuiReserva: sobrescritas.possuiReserva ?? ((id, token) => real.possuiReserva(id, token)),
        liberarLimpeza: sobrescritas.liberarLimpeza ?? ((id, token) => real.liberarLimpeza(id, token)),
        marcarDescartado: sobrescritas.marcarDescartado ?? ((id, token) => real.marcarDescartado(id, token)),
      };
    }

    /** Contexto real (conexão própria, sem índices) com o storage falso no lugar do R2. */
    function abrirComStorageFalso(opcoes: { aoConectar?: (conexao: Connection) => void; leitor?: (real: Leitor) => Partial<Leitor>; storage?: ContextoLimpeza["storage"] } = {}): AbrirContexto {
      const base = criarAbridorDeContexto({ aoConectar: opcoes.aoConectar });
      return async (uri, r2) => {
        const real = await base(uri, r2);
        return { ...real, storage: opcoes.storage ?? storage, leitor: opcoes.leitor ? leitorCom(real.leitor, opcoes.leitor(real.leitor)) : real.leitor };
      };
    }
    /** Pausa uma chamada (depois de executar o original) até o teste liberar. */
    function pausando<A extends unknown[], R>(ponto: PontoDeParada, original: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
      return async (...args: A) => {
        const resultado = await original(...args);
        ponto.chegou.liberar();
        await ponto.liberacao.promessa;
        return resultado;
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

    it("dry-run: só leituras no MongoDB, nenhuma reserva, nenhuma exclusão no storage, registros intactos", async () => {
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

    it("--apply: reserva, exclui só os abandonados não referenciados e os descarta; referenciados devolvidos a pendente; nada mais tocado", async () => {
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
      expect((await uploads().findOne({ _id: r.refId.uploadId }))?.tokenReserva ?? null).toBeNull(); // reserva devolvida
      for (const [item, esperado] of [[r.confirmado, "confirmado"], [r.removido, "removido"], [r.descartado, "descartado"]] as const) {
        expect(await estado(item.uploadId)).toBe(esperado);
        expect(storage.objetos.has(item.chave)).toBe(true);
      }
      expect(await uploads().countDocuments()).toBe(totalAntes);
      expect(texto).toContain("Objetos efetivamente excluídos: 1");
      expect(texto).toContain("Registros marcados como descartados: 2");

      // Só updates em uploads_midia, todos condicionais ao estado; saídas da reserva condicionais ao token.
      const escritas = inst.comandos.filter((e) => COMANDOS_DE_ESCRITA.includes(e.commandName));
      expect(escritas.every((e) => e.commandName === "update" && e.command["update"] === "uploads_midia")).toBe(true);
      const transicoes = escritas.flatMap((e) => (e.command["updates"] as { q: Record<string, unknown>; u: { $set: Record<string, unknown> } }[]).map((item) => [item.q["estado"], item.u.$set["estado"], typeof item.q["tokenReserva"]]));
      expect(transicoes.filter(([, para]) => para === "limpando")).toEqual(Array(4).fill(["pendente", "limpando", "undefined"]));
      expect(transicoes.filter(([, para]) => para === "descartado")).toEqual(Array(2).fill(["limpando", "descartado", "string"]));
      expect(transicoes.filter(([, para]) => para === "pendente")).toEqual(Array(2).fill(["limpando", "pendente", "string"]));
    });

    it("referência legada (variante.foto) ou foto histórica de venda encontrada depois da reserva preserva o objeto e devolve o registro", async () => {
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

    it("referência que aparece DEPOIS da reserva (entre a reserva e a exclusão) é detectada: nada excluído, registro devolvido", async () => {
      const dono = await produto();
      const r = await registro(dono);
      const ponto = novoPonto();
      try {
        const execucao = executar(ARGS_APPLY, abrirComStorageFalso({ leitor: (real) => ({ assumirLimpeza: pausando(ponto, (...a: Parameters<Leitor["assumirLimpeza"]>) => real.assumirLimpeza(...a)) }) }));
        await ponto.chegou.promessa;
        expect(await estado(r.uploadId)).toBe("limpando");
        await produtos().updateOne({ _id: dono }, { $push: { midias: { _id: "legado-x", tipo: "image", chave: r.chave, url: "https://x/l.jpg", ordem: 0 } } });
        ponto.liberacao.liberar();
        expect((await execucao).texto).toContain(`[PRESERVADO_REFERENCIA] upload ${r.uploadId}`);
      } finally {
        liberarTudo(ponto);
      }
      expect(storage.exclusoes).toEqual([]);
      expect(await estado(r.uploadId)).toBe("pendente");
    });

    it("produto inexistente (consulta bem-sucedida, sem documento): limpa e relata", async () => {
      const r = await registro(new Types.ObjectId());
      const { texto } = await executar(ARGS_APPLY, abrirComStorageFalso());
      expect(storage.exclusoes).toEqual([r.chave]);
      expect(await estado(r.uploadId)).toBe("descartado");
      expect(texto).toContain("produto inexistente");
    });

    it("falha de leitura do produto ou das referências depois da reserva: nada excluído, reserva devolvida (pendente)", async () => {
      const r = await registro(await produto());
      for (const metodo of ["produtoExiste", "buscarReferencia"] as const) {
        const { texto } = await executar(
          ARGS_APPLY,
          abrirComStorageFalso({
            leitor: () =>
              metodo === "produtoExiste"
                ? { produtoExiste: () => Promise.reject(new Error(`falha simulada ${MONGODB_URI_TESTE}`)) }
                : { buscarReferencia: () => Promise.reject(new Error("falha simulada")) },
          }),
        );
        expect(texto).toContain(`[FALHA_CONSULTA] upload ${r.uploadId}`);
        expect(texto).not.toContain("mongodb://");
        expect(await estado(r.uploadId)).toBe("pendente");
      }
      expect(storage.exclusoes).toEqual([]);
    });

    it("falha ao consultar o storage e falha na exclusão: reserva devolvida (pendente), objeto preservado", async () => {
      const r = await registro(await produto());
      storage.falhas.inspecionar = true;
      expect((await executar(ARGS_APPLY, abrirComStorageFalso())).texto).toContain(`[FALHA_LEITURA_STORAGE] upload ${r.uploadId}`);
      expect(await estado(r.uploadId)).toBe("pendente");
      storage.falhas.inspecionar = false;
      storage.falhas.excluir = true;
      const { codigo, texto } = await executar(ARGS_APPLY, abrirComStorageFalso());
      expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
      expect(texto).toContain(`[FALHA_EXCLUSAO] upload ${r.uploadId}`);
      expect(storage.objetos.has(r.chave)).toBe(true);
      expect(await estado(r.uploadId)).toBe("pendente");
    });

    it("queda depois da reserva (antes do storage): o registro fica em limpeza, não é tocado dentro do prazo e é retomado depois dele", async () => {
      const r = await registro(await produto());
      // Simula a queda: a leitura falha e a devolução da reserva também.
      await executar(
        ARGS_APPLY,
        abrirComStorageFalso({ leitor: () => ({ produtoExiste: () => Promise.reject(new Error("queda simulada")), liberarLimpeza: () => Promise.reject(new Error("queda simulada")) }) }),
      );
      expect(await estado(r.uploadId)).toBe("limpando");
      expect(storage.exclusoes).toEqual([]);

      const dentroDoPrazo = await executar(ARGS_APPLY, abrirComStorageFalso());
      expect(dentroDoPrazo.texto).toContain("Limpezas em andamento em outra execução (reserva com menos de 30 min — não tocadas): 1");
      expect(storage.exclusoes).toEqual([]);

      const depois = await executar(ARGS_APPLY, abrirComStorageFalso(), { agora: DEPOIS_DO_PRAZO_DE_RECUPERACAO });
      expect(depois.texto).toContain(`[EXCLUIDO_E_DESCARTADO] upload ${r.uploadId} chave=${r.chave}: [reserva interrompida retomada]`);
      expect(depois.texto).toContain("Reservas de limpeza interrompidas retomadas: 1");
      expect(storage.exclusoes).toEqual([r.chave]);
      expect(await estado(r.uploadId)).toBe("descartado");
    });

    it("falha ao marcar descartado depois do DeleteObject: registro fica em limpeza e a retomada conclui (objeto já ausente), sem excluir de novo", async () => {
      const r = await registro(await produto());
      const primeira = await executar(ARGS_APPLY, abrirComStorageFalso({ leitor: () => ({ marcarDescartado: () => Promise.reject(new Error("falha simulada do MongoDB")) }) }));
      expect(primeira.texto).toContain(`[FALHA_ATUALIZACAO] upload ${r.uploadId}`);
      expect(storage.exclusoes).toEqual([r.chave]);
      expect(await estado(r.uploadId)).toBe("limpando");

      const segunda = await executar(ARGS_APPLY, abrirComStorageFalso(), { agora: DEPOIS_DO_PRAZO_DE_RECUPERACAO });
      expect(segunda.codigo).toBe(CODIGOS_DE_SAIDA.sucesso);
      expect(segunda.texto).toContain(`[DESCARTADO_AUSENTE] upload ${r.uploadId}`);
      expect(await estado(r.uploadId)).toBe("descartado");
      expect(storage.exclusoes).toEqual([r.chave]);
    });

    it("recuperação de reserva abandonada só depois do prazo: recente não é tocada; antiga é retomada com token novo", async () => {
      const dono = await produto();
      const recente = await registro(dono, "limpando", "vencido", true, { token: "token-recente", em: new Date(AGORA.getTime() - 5 * 60 * 1000) });
      const antiga = await registro(dono, "limpando", "vencido", true, { token: "token-antigo", em: new Date(AGORA.getTime() - PRAZO_RECUPERACAO_LIMPEZA_MS - 60 * 1000) });
      const { texto } = await executar(ARGS_APPLY, abrirComStorageFalso());
      expect(texto).toContain(`[EXCLUIDO_E_DESCARTADO] upload ${antiga.uploadId}`);
      expect(await estado(antiga.uploadId)).toBe("descartado");
      expect(await estado(recente.uploadId)).toBe("limpando");
      expect((await uploads().findOne({ _id: recente.uploadId }))?.tokenReserva).toBe("token-recente");
      expect(storage.exclusoes).toEqual([antiga.chave]);
    });

    it("instância antiga cuja reserva foi retomada por uma execução mais nova não altera mais nada (nem exclui depois de perder a posse)", async () => {
      const r = await registro(await produto());
      const ponto = novoPonto();
      try {
        // A: reserva e para antes de consultar o produto.
        const antiga = executar(ARGS_APPLY, abrirComStorageFalso({ leitor: (real) => ({ assumirLimpeza: pausando(ponto, (...a: Parameters<Leitor["assumirLimpeza"]>) => real.assumirLimpeza(...a)) }) }));
        await ponto.chegou.promessa;
        // B: depois do prazo de recuperação, retoma a reserva (token novo) e conclui.
        const nova = await executar(ARGS_APPLY, abrirComStorageFalso(), { agora: DEPOIS_DO_PRAZO_DE_RECUPERACAO });
        expect(nova.texto).toContain(`[EXCLUIDO_E_DESCARTADO] upload ${r.uploadId}`);
        ponto.liberacao.liberar();
        const textoAntiga = (await antiga).texto;
        expect(textoAntiga).toContain(`[CONFLITO] upload ${r.uploadId}`);
      } finally {
        liberarTudo(ponto);
      }
      expect(storage.exclusoes).toEqual([r.chave]); // uma única exclusão, pela execução mais nova
      expect(await estado(r.uploadId)).toBe("descartado");
    });

    it("instância antiga que perde a posse depois de verificar o objeto não exclui: a posse é conferida imediatamente antes do DeleteObject", async () => {
      const r = await registro(await produto());
      const pontoA = novoPonto();
      const pontoB = novoPonto();
      try {
        // A: reserva, verifica o objeto (existe) e para antes de conferir a posse.
        const storageA: ContextoLimpeza["storage"] = {
          inspecionarObjeto: pausando(pontoA, (chave: string) => storage.inspecionarObjeto(chave)),
          excluirObjeto: (chave) => storage.excluirObjeto(chave),
        };
        const antiga = executar(ARGS_APPLY, abrirComStorageFalso({ storage: storageA }));
        await pontoA.chegou.promessa;
        // B: depois do prazo, retoma a reserva e para segurando-a.
        const nova = executar(
          ARGS_APPLY,
          abrirComStorageFalso({ leitor: (real) => ({ recuperarLimpeza: pausando(pontoB, (...a: Parameters<Leitor["recuperarLimpeza"]>) => real.recuperarLimpeza(...a)) }) }),
          { agora: DEPOIS_DO_PRAZO_DE_RECUPERACAO },
        );
        await pontoB.chegou.promessa;
        pontoA.liberacao.liberar();
        expect((await antiga).texto).toContain("a reserva foi retomada por outra execução antes da exclusão");
        expect(storage.exclusoes).toEqual([]);
        pontoB.liberacao.liberar();
        expect((await nova).texto).toContain(`[EXCLUIDO_E_DESCARTADO] upload ${r.uploadId}`);
      } finally {
        liberarTudo(pontoA, pontoB);
      }
      expect(storage.exclusoes).toEqual([r.chave]);
      expect(await estado(r.uploadId)).toBe("descartado");
    });

    it("referência que aparece entre a verificação do objeto e a exclusão é detectada na revalidação final", async () => {
      const dono = await produto();
      const r = await registro(dono);
      const ponto = novoPonto();
      try {
        const storagePausado: ContextoLimpeza["storage"] = {
          inspecionarObjeto: pausando(ponto, (chave: string) => storage.inspecionarObjeto(chave)),
          excluirObjeto: (chave) => storage.excluirObjeto(chave),
        };
        const execucao = executar(ARGS_APPLY, abrirComStorageFalso({ storage: storagePausado }));
        await ponto.chegou.promessa;
        await produtos().updateOne({ _id: dono }, { $push: { midias: { _id: "legado-y", tipo: "image", chave: r.chave, url: "https://x/y.jpg", ordem: 0 } } });
        ponto.liberacao.liberar();
        expect((await execucao).texto).toContain(`[PRESERVADO_REFERENCIA] upload ${r.uploadId}`);
      } finally {
        liberarTudo(ponto);
      }
      expect(storage.exclusoes).toEqual([]);
      expect(await estado(r.uploadId)).toBe("pendente");
    });

    it("instância antiga parada entre o DeleteObject e a marcação: a mais nova conclui; a marcação da antiga é recusada pelo token", async () => {
      const r = await registro(await produto());
      const ponto = novoPonto();
      try {
        const antiga = executar(
          ARGS_APPLY,
          abrirComStorageFalso({
            leitor: (real) => ({
              marcarDescartado: async (id, token) => {
                ponto.chegou.liberar();
                await ponto.liberacao.promessa;
                return real.marcarDescartado(id, token);
              },
            }),
          }),
        );
        await ponto.chegou.promessa;
        expect(storage.exclusoes).toEqual([r.chave]);
        const nova = await executar(ARGS_APPLY, abrirComStorageFalso(), { agora: DEPOIS_DO_PRAZO_DE_RECUPERACAO });
        expect(nova.texto).toContain(`[DESCARTADO_AUSENTE] upload ${r.uploadId}`);
        ponto.liberacao.liberar();
        expect((await antiga).texto).toContain(`[CONFLITO] upload ${r.uploadId}`);
      } finally {
        liberarTudo(ponto);
      }
      expect(await estado(r.uploadId)).toBe("descartado");
    });

    it("duas execuções disputando a retomada da MESMA reserva interrompida: exatamente uma retoma; a outra relata conflito antes da reserva", async () => {
      const r = await registro(await produto(), "limpando", "vencido", true, { token: "token-antigo", em: new Date(AGORA.getTime() - PRAZO_RECUPERACAO_LIMPEZA_MS - 60 * 1000) });
      const pontos = [novoPonto(), novoPonto()];
      let chamada = 0;
      const abrir = abrirComStorageFalso({
        leitor: (real) => ({
          recuperarLimpeza: async (...a: Parameters<Leitor["recuperarLimpeza"]>) => {
            const ponto = pontos[chamada];
            chamada += 1;
            if (ponto) {
              ponto.chegou.liberar();
              await ponto.liberacao.promessa;
            }
            return real.recuperarLimpeza(...a);
          },
        }),
      });
      try {
        const a = executar(ARGS_APPLY, abrir);
        const b = executar(ARGS_APPLY, abrir);
        await Promise.all(pontos.map((ponto) => ponto.chegou.promessa));
        liberarTudo(...pontos);
        const textos = (await Promise.all([a, b])).map((resultado) => resultado.texto);
        expect(textos.filter((texto) => texto.includes(`[EXCLUIDO_E_DESCARTADO] upload ${r.uploadId}`))).toHaveLength(1);
        expect(textos.filter((texto) => texto.includes(`[CONFLITO] upload ${r.uploadId}`) && texto.includes("antes da reserva"))).toHaveLength(1);
      } finally {
        liberarTudo(...pontos);
      }
      expect(storage.exclusoes).toEqual([r.chave]);
    });

    it("duas limpezas simultâneas disputando a reserva: exatamente uma assume e exclui; a outra relata conflito sem tocar o storage", async () => {
      const r = await registro(await produto());
      const pontos = [novoPonto(), novoPonto()];
      let chamada = 0;
      const abrir = abrirComStorageFalso({
        leitor: (real) => ({
          assumirLimpeza: async (...a: Parameters<Leitor["assumirLimpeza"]>) => {
            const ponto = pontos[chamada];
            chamada += 1;
            if (ponto) {
              ponto.chegou.liberar();
              await ponto.liberacao.promessa;
            }
            return real.assumirLimpeza(...a);
          },
        }),
      });
      try {
        const a = executar(ARGS_APPLY, abrir);
        const b = executar(ARGS_APPLY, abrir);
        await Promise.all(pontos.map((ponto) => ponto.chegou.promessa)); // as duas vão reservar ao mesmo tempo
        liberarTudo(...pontos);
        const textos = (await Promise.all([a, b])).map((resultado) => resultado.texto);
        expect(textos.filter((texto) => texto.includes(`[EXCLUIDO_E_DESCARTADO] upload ${r.uploadId}`))).toHaveLength(1);
        expect(textos.filter((texto) => texto.includes(`[CONFLITO] upload ${r.uploadId}`) && texto.includes("antes da reserva"))).toHaveLength(1);
      } finally {
        liberarTudo(...pontos);
      }
      expect(storage.exclusoes).toEqual([r.chave]);
      expect(await estado(r.uploadId)).toBe("descartado");
    });

    it("registros em confirmação nunca são tocados; vencidos são relatados para análise manual", async () => {
      const dono = await produto();
      const emAndamento = await registro(dono, "confirmando", "futuro");
      const interrompida = await registro(dono, "confirmando", "vencido");
      const { codigo, texto } = await executar(ARGS_APPLY, abrirComStorageFalso());
      expect(codigo).toBe(CODIGOS_DE_SAIDA.intervencaoNecessaria);
      expect(texto).toContain("Em confirmação (reserva da confirmação — nunca tocados): 1");
      expect(texto).toContain(`[CONFIRMACAO_INTERROMPIDA] upload ${interrompida.uploadId}`);
      expect(storage.exclusoes).toEqual([]);
      expect(await estado(emAndamento.uploadId)).toBe("confirmando");
      expect(await estado(interrompida.uploadId)).toBe("confirmando");
    });

    it("registro alterado por fora durante a limpeza (posse perdida): nada é excluído", async () => {
      const r = await registro(await produto());
      const ponto = novoPonto();
      try {
        const execucao = executar(ARGS_APPLY, abrirComStorageFalso({ leitor: (real) => ({ assumirLimpeza: pausando(ponto, (...a: Parameters<Leitor["assumirLimpeza"]>) => real.assumirLimpeza(...a)) }) }));
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
