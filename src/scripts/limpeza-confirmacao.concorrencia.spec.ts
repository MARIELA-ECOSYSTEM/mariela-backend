import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { fileURLToPath } from "node:url";
import { Types, type Connection } from "mongoose";
import { ApiException } from "../common/exceptions/api.exception.js";
import { liberarTudo, novoPonto } from "../test-utils/barreira.util.js";
import { garantirItemConfiguracao } from "../test-utils/configuracoes-teste.util.js";
import { arquivoDoFormato, MediaStorageFalso } from "../test-utils/media-storage-falso.util.js";
import { MONGODB_URI_TESTE, mongooseModuloDeTeste } from "../test-utils/mongo-teste.util.js";
import { ConfiguracoesService } from "../modules/configuracoes/configuracoes.service.js";
import { GaleriaService } from "../modules/media/galeria.service.js";
import { MEDIA_STORAGE } from "../modules/media/media.constants.js";
import { MediaModule } from "../modules/media/media.module.js";
import { UploadsMidiaRepository } from "../modules/media/uploads/uploads-midia.repository.js";
import { ProdutosRepository } from "../modules/produtos/produtos.repository.js";
import { ProdutosService } from "../modules/produtos/produtos.service.js";
import type { Sequencia } from "../modules/sequencias/schemas/sequencia.schema.js";
import type { AmbienteDeExecucao } from "./comando-local.util.js";
import { criarAbridorDeContexto, executarComando, type AbrirContexto, type ConfigR2, type ContextoLimpeza } from "./limpar-uploads-abandonados.comando.js";

/**
 * Fase 60.3.1 — concorrência REAL entre a confirmação de upload (`GaleriaService` de verdade) e a limpeza de uploads
 * abandonados (comando de verdade), no `mariela_test`, com o MESMO storage falso para os dois. Barreiras
 * determinísticas posicionam cada operação no ponto crítico da outra.
 *
 * Critério de aceite verificado ao fim de CADA cenário: nenhum produto referencia uma chave cujo objeto a limpeza
 * excluiu (`invarianteSemReferenciaQuebrada`).
 */

const JWT_MODULO_DE_TESTE = JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });
const R2_FICTICIO: ConfigR2 = { accountId: "conta", accessKeyId: "AKIAFICTICIO", secretAccessKey: "segredo-ficticio", bucketName: "bucket", publicBaseUrl: "https://midia.exemplo.com" };
const CONFIG_DE_TESTE = () => ({ storage: { r2: R2_FICTICIO } });
const EXECUCAO_LOCAL: AmbienteDeExecucao = {
  arquivoDeEntrada: fileURLToPath(new URL("./limpar-uploads-abandonados.ts", import.meta.url)),
  variaveis: {},
  existeArquivo: () => false,
};
const DOIS_DIAS = 2 * 24 * 60 * 60 * 1000;

describe("concorrência confirmação × limpeza de uploads (Fase 60.3.1)", () => {
  let moduleRef: TestingModule;
  let galeria: GaleriaService;
  let produtosService: ProdutosService;
  let produtosRepository: ProdutosRepository;
  let connection: Connection;
  const storage = new MediaStorageFalso();
  let contador = 0;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [mongooseModuloDeTeste(), JWT_MODULO_DE_TESTE, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [CONFIG_DE_TESTE] }), MediaModule],
    })
      .overrideProvider(MEDIA_STORAGE)
      .useValue(storage)
      .compile();
    await moduleRef.init();
    galeria = moduleRef.get(GaleriaService);
    produtosService = moduleRef.get(ProdutosService);
    produtosRepository = moduleRef.get(ProdutosRepository);
    connection = moduleRef.get(getConnectionToken());
    await garantirItemConfiguracao(moduleRef.get(ConfiguracoesService), "categorias", "Vestidos");
  });
  // Cada cenário começa com o storage falso, os produtos e os registros vazios: o invariante olha o banco inteiro.
  beforeEach(async () => {
    storage.reiniciar();
    await connection.collection("produtos").deleteMany({});
    await connection.collection("uploads_midia").deleteMany({});
  });
  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("uploads_midia").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["produto"] } });
    await moduleRef.close();
  });

  const uploads = () => connection.collection<{ _id: string; estado: string; limpezaApos: Date }>("uploads_midia");

  async function novoProduto(): Promise<string> {
    contador += 1;
    return (await produtosService.criar({ nome: `Produto Concorrência ${contador}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false }, null)).id;
  }
  /** Solicita pelo serviço real e simula o PUT do cliente. */
  async function enviado(produtoId: string): Promise<{ uploadId: string; chave: string }> {
    const { uploadId } = await galeria.solicitarUpload(produtoId, { fileName: "foto.jpg", contentType: "image/jpeg", kind: "image", size: 1024 }, null);
    const chave = storage.ultimaChave();
    storage.enviar(chave, arquivoDoFormato("image/jpeg"), "image/jpeg");
    return { uploadId, chave };
  }
  async function definirLimpezaApos(uploadId: string, quando: Date): Promise<void> {
    await uploads().updateOne({ _id: uploadId }, { $set: { limpezaApos: quando } });
  }
  async function estado(uploadId: string): Promise<string | undefined> {
    return (await uploads().findOne({ _id: uploadId }))?.estado;
  }

  /** Limpeza real (`--apply`) com o storage falso; `agora` permite simular relógio adiantado (vencimento). */
  async function limpar(opcoes: { agora?: Date; leitor?: (real: ContextoLimpeza["leitor"]) => Partial<ContextoLimpeza["leitor"]> } = {}) {
    const base = criarAbridorDeContexto();
    const abrir: AbrirContexto = async (uri, r2) => {
      const real = await base(uri, r2);
      const sobrescritas = opcoes.leitor?.(real.leitor) ?? {};
      return { ...real, storage, leitor: { ...bind(real.leitor), ...sobrescritas } };
    };
    const saida: string[] = [];
    await executarComando({
      argv: ["--banco", "mariela_test", "--apply"],
      uri: MONGODB_URI_TESTE,
      r2: R2_FICTICIO,
      escrever: (linha) => saida.push(linha),
      abrirContexto: abrir,
      execucao: EXECUCAO_LOCAL,
      agora: () => opcoes.agora ?? new Date(),
    });
    return saida.join("\n");
  }
  function bind(leitor: ContextoLimpeza["leitor"]): ContextoLimpeza["leitor"] {
    return {
      listarRegistros: () => leitor.listarRegistros(),
      lerRegistro: (id) => leitor.lerRegistro(id),
      produtoExiste: (id) => leitor.produtoExiste(id),
      buscarReferencia: (id, chave) => leitor.buscarReferencia(id, chave),
      assumirLimpeza: (id, limite, token, agora) => leitor.assumirLimpeza(id, limite, token, agora),
      recuperarLimpeza: (id, antigo, limite, token, agora) => leitor.recuperarLimpeza(id, antigo, limite, token, agora),
      possuiReserva: (id, token) => leitor.possuiReserva(id, token),
      liberarLimpeza: (id, token) => leitor.liberarLimpeza(id, token),
      marcarDescartado: (id, token) => leitor.marcarDescartado(id, token),
    };
  }

  async function erroApi(promessa: Promise<unknown>): Promise<ApiException> {
    try {
      await promessa;
    } catch (erro) {
      if (erro instanceof ApiException) return erro;
      throw erro;
    }
    throw new Error("Esperava uma ApiException, mas a operação concluiu.");
  }

  /** CRITÉRIO DE ACEITE: nenhuma referência (galeria) a uma chave cujo objeto foi excluído pela limpeza. */
  async function invarianteSemReferenciaQuebrada(): Promise<void> {
    const docs = await connection.collection<{ _id: Types.ObjectId; midias?: { chave: string | null }[] }>("produtos").find({}).toArray();
    const referenciadas = docs.flatMap((doc) => (doc.midias ?? []).map((midia) => midia.chave)).filter((chave): chave is string => chave !== null);
    for (const chave of referenciadas) {
      expect(storage.exclusoes).not.toContain(chave);
      expect(storage.objetos.has(chave)).toBe(true);
    }
  }

  it("confirmação que começou ANTES e tenta gravar DEPOIS de a limpeza assumir e excluir: recusada (409), produto intacto", async () => {
    const produtoId = await novoProduto();
    const { uploadId, chave } = await enviado(produtoId);
    const ponto = novoPonto();
    const lerOriginal = storage.lerPrimeirosBytes.bind(storage);
    const espiao = spyOn(storage, "lerPrimeirosBytes").mockImplementationOnce(async (key: string, quantidade: number) => {
      const bytes = await lerOriginal(key, quantidade);
      ponto.chegou.liberar(); // a confirmação já leu o registro (pendente, no prazo) e validou o objeto
      await ponto.liberacao.promessa;
      return bytes;
    });
    try {
      const confirmacao = erroApi(galeria.confirmarUpload(produtoId, uploadId, {}, null));
      await ponto.chegou.promessa;
      await definirLimpezaApos(uploadId, new Date(Date.now() - 60 * 60 * 1000));
      const relatorio = await limpar();
      expect(relatorio).toContain(`[EXCLUIDO_E_DESCARTADO] upload ${uploadId}`);
      // Relógio do servidor da confirmação "atrasado": para ele o prazo ainda não venceu — mesmo assim a reserva falha.
      await definirLimpezaApos(uploadId, new Date(Date.now() + 60 * 60 * 1000));
      ponto.liberacao.liberar();
      const erro = await confirmacao;
      expect(erro.getStatus()).toBe(409);
    } finally {
      liberarTudo(ponto);
      espiao.mockRestore();
    }
    expect(storage.exclusoes).toEqual([chave]);
    expect((await produtosService.obterPorId(produtoId)).midias).toHaveLength(0);
    expect(await estado(uploadId)).toBe("descartado");
    await invarianteSemReferenciaQuebrada();
  });

  it("limpeza que assume ANTES da confirmação: a confirmação é recusada enquanto o registro está em limpeza (mesmo com relógio atrasado)", async () => {
    const produtoId = await novoProduto();
    const { uploadId, chave } = await enviado(produtoId);
    await definirLimpezaApos(uploadId, new Date(Date.now() - 60 * 60 * 1000));
    const ponto = novoPonto();
    try {
      const limpeza = limpar({
        leitor: (real) => ({
          assumirLimpeza: async (...a: Parameters<ContextoLimpeza["leitor"]["assumirLimpeza"]>) => {
            const assumiu = await real.assumirLimpeza(...a);
            ponto.chegou.liberar();
            await ponto.liberacao.promessa;
            return assumiu;
          },
        }),
      });
      await ponto.chegou.promessa;
      expect(await estado(uploadId)).toBe("limpando");
      expect((await erroApi(galeria.confirmarUpload(produtoId, uploadId, {}, null))).getStatus()).toBe(409);
      await definirLimpezaApos(uploadId, new Date(Date.now() + 60 * 60 * 1000));
      expect((await erroApi(galeria.confirmarUpload(produtoId, uploadId, {}, null))).getStatus()).toBe(409);
      expect((await produtosService.obterPorId(produtoId)).midias).toHaveLength(0);
      // Devolve o vencimento para a limpeza seguir (ela já tem a reserva; o prazo não é relido para excluir).
      await definirLimpezaApos(uploadId, new Date(Date.now() - 60 * 60 * 1000));
      ponto.liberacao.liberar();
      expect(await limpeza).toContain(`[EXCLUIDO_E_DESCARTADO] upload ${uploadId}`);
    } finally {
      liberarTudo(ponto);
    }
    expect(storage.exclusoes).toEqual([chave]);
    await invarianteSemReferenciaQuebrada();
  });

  it("confirmação que reservou PRIMEIRO e está gravando o produto: a limpeza não toca o registro; a confirmação conclui e o objeto fica", async () => {
    const produtoId = await novoProduto();
    const { uploadId, chave } = await enviado(produtoId);
    const ponto = novoPonto();
    const salvarOriginal = produtosRepository.salvarComRetentativa.bind(produtosRepository);
    const espiao = spyOn(produtosRepository, "salvarComRetentativa").mockImplementationOnce(async (id, mutar, tentativas) => {
      ponto.chegou.liberar(); // reserva `confirmando` já adquirida; a escrita do produto ainda não aconteceu
      await ponto.liberacao.promessa;
      return salvarOriginal(id, mutar, tentativas);
    });
    try {
      const confirmacao = galeria.confirmarUpload(produtoId, uploadId, {}, null);
      await ponto.chegou.promessa;
      expect(await estado(uploadId)).toBe("confirmando");
      const relatorio = await limpar({ agora: new Date(Date.now() + DOIS_DIAS) }); // relógio da limpeza adiantado
      expect(relatorio).toContain(`[CONFIRMACAO_INTERROMPIDA] upload ${uploadId}`);
      expect(storage.exclusoes).toEqual([]);
      ponto.liberacao.liberar();
      expect((await confirmacao).midia._id).toBe(uploadId);
    } finally {
      liberarTudo(ponto);
      espiao.mockRestore();
    }
    expect(await estado(uploadId)).toBe("confirmado");
    expect(storage.objetos.has(chave)).toBe(true);
    await invarianteSemReferenciaQuebrada();
  });

  it("limpeza que listou o registro como pendente, mas a confirmação reservou e gravou antes da reserva da limpeza: a reserva da limpeza falha, nada é excluído", async () => {
    const produtoId = await novoProduto();
    const { uploadId, chave } = await enviado(produtoId);
    const ponto = novoPonto();
    try {
      const limpeza = limpar({
        agora: new Date(Date.now() + DOIS_DIAS), // relógio adiantado: para a limpeza, o registro já venceu
        leitor: (real) => ({
          listarRegistros: async () => {
            const registros = await real.listarRegistros();
            ponto.chegou.liberar();
            await ponto.liberacao.promessa;
            return registros;
          },
        }),
      });
      await ponto.chegou.promessa;
      expect((await galeria.confirmarUpload(produtoId, uploadId, {}, null)).midia._id).toBe(uploadId);
      ponto.liberacao.liberar();
      expect(await limpeza).toContain(`[CONFLITO] upload ${uploadId}`);
    } finally {
      liberarTudo(ponto);
    }
    expect(storage.exclusoes).toEqual([]);
    expect(storage.objetos.has(chave)).toBe(true);
    expect(await estado(uploadId)).toBe("confirmado");
    await invarianteSemReferenciaQuebrada();
  });

  it("confirmação reservada cuja escrita é recusada (variante inexistente) devolve a reserva; a limpeza posterior exclui com segurança", async () => {
    const produtoId = await novoProduto();
    const { uploadId, chave } = await enviado(produtoId);
    expect((await erroApi(galeria.confirmarUpload(produtoId, uploadId, { varianteId: new Types.ObjectId().toHexString() }, null))).getStatus()).toBe(400);
    expect(await estado(uploadId)).toBe("pendente");
    expect(await limpar({ agora: new Date(Date.now() + DOIS_DIAS) })).toContain(`[EXCLUIDO_E_DESCARTADO] upload ${uploadId}`);
    expect(storage.exclusoes).toEqual([chave]);
    expect((await produtosService.obterPorId(produtoId)).midias).toHaveLength(0);
    await invarianteSemReferenciaQuebrada();
  });

  it("registro já tocado pela limpeza (devolvido a pendente) nunca mais é confirmável, mesmo com relógio atrasado", async () => {
    const produtoId = await novoProduto();
    const { uploadId, chave } = await enviado(produtoId);
    storage.falhas.inspecionar = true; // a limpeza reserva, não consegue ler o storage e devolve o registro
    expect(await limpar({ agora: new Date(Date.now() + DOIS_DIAS) })).toContain(`[FALHA_LEITURA_STORAGE] upload ${uploadId}`);
    storage.falhas.inspecionar = false;
    expect(await estado(uploadId)).toBe("pendente");
    // Para o relógio da confirmação o prazo não venceu (limpezaApos no futuro) — mesmo assim a reserva é recusada.
    expect((await erroApi(galeria.confirmarUpload(produtoId, uploadId, {}, null))).getStatus()).toBe(409);
    expect((await produtosService.obterPorId(produtoId)).midias).toHaveLength(0);
    expect(await estado(uploadId)).toBe("pendente");
    expect(storage.objetos.has(chave)).toBe(true);
    await invarianteSemReferenciaQuebrada();
  });

  it("instância antiga parada antes do DeleteObject, reserva retomada e devolvida por outra, e confirmação com relógio atrasado: a confirmação é recusada e a exclusão tardia não quebra referência", async () => {
    const produtoId = await novoProduto();
    const { uploadId, chave } = await enviado(produtoId);
    const ponto = novoPonto();
    const agoraA = new Date(Date.now() + DOIS_DIAS);
    const excluirOriginal = storage.excluirObjeto.bind(storage);
    const espiao = spyOn(storage, "excluirObjeto").mockImplementationOnce(async (key: string) => {
      ponto.chegou.liberar(); // A já conferiu posse e referências; vai excluir
      await ponto.liberacao.promessa;
      return excluirOriginal(key);
    });
    try {
      const antiga = limpar({ agora: agoraA });
      await ponto.chegou.promessa;
      // B: depois do prazo de recuperação, retoma a reserva, falha ao ler o storage e devolve o registro a pendente.
      storage.falhas.inspecionar = true;
      expect(await limpar({ agora: new Date(agoraA.getTime() + 31 * 60 * 1000) })).toContain(`[FALHA_LEITURA_STORAGE] upload ${uploadId}`);
      storage.falhas.inspecionar = false;
      expect(await estado(uploadId)).toBe("pendente");
      // Confirmação num servidor com relógio atrasado: recusada pela marca permanente da limpeza.
      expect((await erroApi(galeria.confirmarUpload(produtoId, uploadId, {}, null))).getStatus()).toBe(409);
      ponto.liberacao.liberar();
      expect(await antiga).toContain(`[CONFLITO] upload ${uploadId}`); // excluiu, mas a marcação dela é recusada pelo token
    } finally {
      liberarTudo(ponto);
      espiao.mockRestore();
    }
    expect(storage.exclusoes).toEqual([chave]);
    expect((await produtosService.obterPorId(produtoId)).midias).toHaveLength(0);
    await invarianteSemReferenciaQuebrada();
    // A próxima execução conclui o registro (objeto já ausente).
    expect(await limpar({ agora: new Date(agoraA.getTime() + 2 * 60 * 60 * 1000) })).toContain(`[DESCARTADO_AUSENTE] upload ${uploadId}`);
  });

  it("reconciliação durante a reserva da limpeza (produto já referencia a mídia): o registro não é tomado da limpeza; ela preserva e devolve; nova confirmação conclui", async () => {
    const produtoId = await novoProduto();
    const { uploadId, chave } = await enviado(produtoId);
    // Produto gravado, registro não concluído (falha parcial da confirmação): fica em `confirmando`.
    const falha = spyOn(moduleRef.get(UploadsMidiaRepository), "marcarConfirmado").mockImplementationOnce(async () => {
      throw new Error("queda simulada");
    });
    try {
      await galeria.confirmarUpload(produtoId, uploadId, {}, null);
    } finally {
      falha.mockRestore();
    }
    // Cenário de dado legado/antigo: o mesmo registro em `pendente` vencido com o produto já referenciando a mídia.
    await uploads().updateOne({ _id: uploadId }, { $set: { estado: "pendente", tokenReserva: null, reservadoEm: null } });
    const ponto = novoPonto();
    try {
      const limpeza = limpar({
        agora: new Date(Date.now() + DOIS_DIAS),
        leitor: (real) => ({
          assumirLimpeza: async (...a: Parameters<ContextoLimpeza["leitor"]["assumirLimpeza"]>) => {
            const assumiu = await real.assumirLimpeza(...a);
            ponto.chegou.liberar();
            await ponto.liberacao.promessa;
            return assumiu;
          },
        }),
      });
      await ponto.chegou.promessa;
      expect(await estado(uploadId)).toBe("limpando");
      await galeria.confirmarUpload(produtoId, uploadId, {}, null); // caminho de reconciliação
      expect(await estado(uploadId)).toBe("limpando"); // nunca tomado da limpeza
      ponto.liberacao.liberar();
      expect(await limpeza).toContain(`[PRESERVADO_REFERENCIA] upload ${uploadId}`);
    } finally {
      liberarTudo(ponto);
    }
    expect(await estado(uploadId)).toBe("pendente");
    await galeria.confirmarUpload(produtoId, uploadId, {}, null);
    expect(await estado(uploadId)).toBe("confirmado");
    expect(storage.exclusoes).toEqual([]);
    expect(storage.objetos.has(chave)).toBe(true);
    await invarianteSemReferenciaQuebrada();
  });

  it("confirmação interrompida depois de gravar o produto (registro em confirmação): a limpeza nunca exclui; nova confirmação reconcilia", async () => {
    const produtoId = await novoProduto();
    const { uploadId, chave } = await enviado(produtoId);
    // Simula a interrupção logo depois de gravar o produto: a conclusão do registro falha.
    const espiao = spyOn(moduleRef.get(UploadsMidiaRepository), "marcarConfirmado").mockImplementationOnce(async () => {
      throw new Error("queda simulada");
    });
    try {
      await galeria.confirmarUpload(produtoId, uploadId, {}, null);
    } finally {
      espiao.mockRestore();
    }
    expect(await estado(uploadId)).toBe("confirmando");
    expect(await limpar({ agora: new Date(Date.now() + DOIS_DIAS) })).toContain(`[CONFIRMACAO_INTERROMPIDA] upload ${uploadId}`);
    expect(storage.exclusoes).toEqual([]);
    await galeria.confirmarUpload(produtoId, uploadId, {}, null);
    expect(await estado(uploadId)).toBe("confirmado");
    expect(storage.objetos.has(chave)).toBe(true);
    await invarianteSemReferenciaQuebrada();
  });
});
