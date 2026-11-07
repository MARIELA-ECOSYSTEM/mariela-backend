import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { liberarTudo, novoPonto } from "../../test-utils/barreira.util.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { erroDe, executarComConflitosDeVersao } from "../../test-utils/conflito-versao.util.js";
import { fileURLToPath } from "node:url";
import { arquivoDoFormato, chunkPng, fixtureDeMidia, FIXTURES_MIDIA, inserirMidiaDiretamente, MediaStorageFalso } from "../../test-utils/media-storage-falso.util.js";
import { mp4Sintetico } from "../../test-utils/mp4-sintetico.util.js";
import { ValidadorMidiaService } from "./validacao/validador-midia.service.js";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { ConfiguracoesService } from "../configuracoes/configuracoes.service.js";
import { ProdutosRepository } from "../produtos/produtos.repository.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { Sequencia } from "../sequencias/schemas/sequencia.schema.js";
import type { ConfirmarUploadDto, SolicitarUploadGaleriaDto } from "./dto/galeria.dto.js";
import { GaleriaService } from "./galeria.service.js";
import { CACHE_CONTROL_MIDIA, MEDIA_STORAGE } from "./media.constants.js";
import { MediaModule } from "./media.module.js";
import { UploadsMidiaRepository } from "./uploads/uploads-midia.repository.js";

const JWT_MODULO_DE_TESTE = JwtModule.register({ global: true, secret: "segredo-de-teste", signOptions: { expiresIn: "15m" } });
const BASE_PUBLICA = "https://midia.exemplo.com";
// Credenciais FICTÍCIAS: o storage é o falso (`MediaStorageFalso`); o R2 real nunca é chamado.
const CONFIG_DE_TESTE = () => ({
  storage: { r2: { accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "AKIAFICTICIO", secretAccessKey: "segredo-ficticio", bucketName: "mariela-midia", publicBaseUrl: BASE_PUBLICA } },
});
const NOME_POR_FORMATO: Record<string, string> = {
  "image/jpeg": "foto.jpg",
  "image/png": "foto.png",
  "image/gif": "foto.gif",
  "image/webp": "foto.webp",
  "video/mp4": "video.mp4",
};

interface RegistroUpload {
  _id: string;
  produtoId: Types.ObjectId;
  chave: string;
  estado: string;
  substituiMidiaId?: string | null;
  criadoEm: Date;
  urlExpiraEm: Date;
  limpezaApos: Date;
  confirmadoEm: Date | null;
  removidoEm: Date | null;
}
interface ProdutoBruto {
  _id: Types.ObjectId;
  __v: number;
  excluidoEm: Date | null;
  midiaPrincipalId?: string | null;
  midias?: { _id: string; ordem: number; varianteId: Types.ObjectId | null }[];
}

async function erroApi(promessa: Promise<unknown>): Promise<ApiException> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof ApiException) return erro;
    throw erro;
  }
  throw new Error("Esperava uma ApiException, mas a operação concluiu com sucesso.");
}

describe("GaleriaService (integração — MongoDB real, storage falso)", () => {
  let moduleRef: TestingModule;
  let galeria: GaleriaService;
  let produtosService: ProdutosService;
  let produtosRepository: ProdutosRepository;
  let uploadsRepository: UploadsMidiaRepository;
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
    uploadsRepository = moduleRef.get(UploadsMidiaRepository);
    connection = moduleRef.get(getConnectionToken());
    const configuracoesService = moduleRef.get(ConfiguracoesService);
    await garantirItemConfiguracao(configuracoesService, "categorias", "Vestidos");
    for (const cor of ["Azul", "Preto"]) await garantirItemConfiguracao(configuracoesService, "cores", cor);
  });

  beforeEach(() => storage.reiniciar());

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("uploads_midia").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["produto"] } });
    await moduleRef.close();
  });

  const uploads = () => connection.collection<RegistroUpload>("uploads_midia");
  const produtosBrutos = () => connection.collection<ProdutoBruto>("produtos");

  async function novoProduto(): Promise<string> {
    contador += 1;
    const produto = await produtosService.criar({ nome: `Produto Galeria ${contador}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false }, null);
    return produto.id;
  }
  async function novaVariante(produtoId: string, cor = "Azul"): Promise<string> {
    return String((await produtosService.adicionarVariante(produtoId, { cor }, null))._id);
  }
  async function solicitar(produtoId: string, extra: Partial<SolicitarUploadGaleriaDto> = {}) {
    return galeria.solicitarUpload(produtoId, { fileName: "foto.jpg", contentType: "image/jpeg", kind: "image", size: 1024, ...extra }, "admin-teste");
  }
  /** Solicita e "envia" (PUT simulado) um arquivo real do formato. */
  async function enviado(produtoId: string, formato = "image/jpeg", tamanho = 1024, substituiMidiaId?: string): Promise<{ uploadId: string; chave: string }> {
    const { uploadId } = await solicitar(produtoId, {
      fileName: NOME_POR_FORMATO[formato]!,
      contentType: formato,
      kind: formato.startsWith("video") ? "video" : "image",
      size: tamanho,
      ...(substituiMidiaId ? { substituiMidiaId } : {}),
    });
    const chave = storage.ultimaChave();
    storage.enviar(chave, arquivoDoFormato(formato, tamanho), formato);
    return { uploadId, chave };
  }
  async function confirmar(produtoId: string, uploadId: string, dto: ConfirmarUploadDto = {}) {
    return galeria.confirmarUpload(produtoId, uploadId, dto, "admin-teste");
  }
  async function confirmada(produtoId: string, dto: ConfirmarUploadDto = {}, formato = "image/jpeg"): Promise<string> {
    const { uploadId } = await enviado(produtoId, formato);
    await confirmar(produtoId, uploadId, dto);
    return uploadId;
  }
  async function registro(uploadId: string): Promise<RegistroUpload> {
    const doc = await uploads().findOne({ _id: uploadId });
    if (!doc) throw new Error(`Registro ${uploadId} não existe.`);
    return doc;
  }
  async function produtoBruto(produtoId: string): Promise<ProdutoBruto> {
    const doc = await produtosBrutos().findOne({ _id: new Types.ObjectId(produtoId) });
    if (!doc) throw new Error(`Produto ${produtoId} não existe.`);
    return doc;
  }
  /**
   * Executa confirmações "ao mesmo tempo" de forma determinística: cada uma pausa logo depois de validar o objeto
   * (antes da escrita no produto) e todas só seguem quando todas chegaram — as escritas disputam o mesmo `__v`.
   */
  async function emParalelo<T>(operacoes: (() => Promise<T>)[]): Promise<PromiseSettledResult<T>[]> {
    const pontos = operacoes.map(() => novoPonto());
    let chamada = 0;
    const lerOriginal = storage.lerPrimeirosBytes.bind(storage);
    const espiao = spyOn(storage, "lerPrimeirosBytes").mockImplementation(async (key: string, quantidade: number) => {
      const ponto = pontos[chamada];
      chamada += 1;
      const bytes = await lerOriginal(key, quantidade);
      if (ponto) {
        ponto.chegou.liberar();
        await ponto.liberacao.promessa;
      }
      return bytes;
    });
    try {
      const todas = Promise.allSettled(operacoes.map((operacao) => operacao()));
      // Se alguma terminar antes de chegar à pausa, não espera para sempre: as asserções mostram o motivo.
      await Promise.race([Promise.all(pontos.map((ponto) => ponto.chegou.promessa)), todas]);
      liberarTudo(...pontos);
      return await todas;
    } finally {
      liberarTudo(...pontos);
      espiao.mockRestore();
    }
  }
  const idsDaGaleria = async (produtoId: string) => (await galeria.listar(produtoId)).midias.map((midia) => midia._id);

  describe("solicitação de upload", () => {
    it("válida: cria o registro pendente, assina com Content-Type, Content-Length e Cache-Control, e não altera a galeria", async () => {
      const produtoId = await novoProduto();
      const antes = await produtoBruto(produtoId);
      const inicio = Date.now();
      const resposta = await solicitar(produtoId);

      expect(Object.keys(resposta).sort()).toEqual(["expiresIn", "headers", "method", "uploadId", "uploadUrl"]);
      expect(resposta.method).toBe("PUT");
      expect(resposta.expiresIn).toBe(600);
      expect(resposta.headers).toEqual({ "Content-Type": "image/jpeg", "Cache-Control": CACHE_CONTROL_MIDIA });
      expect(resposta.uploadId).toMatch(/^[0-9a-f-]{36}$/);

      const assinatura = storage.assinaturas[0]!;
      expect(assinatura).toEqual({
        key: `products/${produtoId}/${resposta.uploadId}.jpg`,
        contentType: "image/jpeg",
        contentLength: 1024,
        expiresInSeconds: 600,
        cacheControl: "public, max-age=31536000, immutable",
      });

      const doc = await registro(resposta.uploadId);
      expect(doc.estado).toBe("pendente");
      expect(doc.chave).toBe(assinatura.key);
      expect(String(doc.produtoId)).toBe(produtoId);
      // Dois prazos diferentes: URL (10 min) e registro (24 h).
      expect(doc.urlExpiraEm.getTime() - doc.criadoEm.getTime()).toBe(600_000);
      expect(doc.limpezaApos.getTime() - doc.criadoEm.getTime()).toBe(24 * 60 * 60 * 1000);
      expect(doc.criadoEm.getTime()).toBeGreaterThanOrEqual(inicio - 1000);
      expect(doc.confirmadoEm).toBeNull();

      const depois = await produtoBruto(produtoId);
      expect(depois.__v).toBe(antes.__v);
      expect(depois.midias ?? []).toHaveLength(0);
    });

    it("cada solicitação gera um uploadId e uma chave novos", async () => {
      const produtoId = await novoProduto();
      const a = await solicitar(produtoId);
      const b = await solicitar(produtoId);
      expect(a.uploadId).not.toBe(b.uploadId);
      expect(storage.assinaturas[0]!.key).not.toBe(storage.assinaturas[1]!.key);
    });

    it("MIME inválido, extensão divergente e tamanho excedido retornam 400 sem criar registro", async () => {
      const produtoId = await novoProduto();
      const casos: [Partial<SolicitarUploadGaleriaDto>, string][] = [
        [{ fileName: "x.svg", contentType: "image/svg+xml" }, "contentType"],
        [{ fileName: "foto.png" }, "fileName"],
        [{ size: 5 * 1024 * 1024 + 1 }, "size"],
        [{ fileName: "v.mp4", contentType: "video/mp4", kind: "video", size: 15 * 1024 * 1024 + 1 }, "size"],
        [{ fileName: "v.mp4", contentType: "video/mp4", kind: "image" }, "kind"],
      ];
      for (const [extra, campo] of casos) {
        const erro = await erroApi(solicitar(produtoId, extra));
        expect(erro.getStatus()).toBe(400);
        expect(erro.errors.map((e) => e.field)).toContain(campo);
      }
      expect(await uploads().countDocuments({ produtoId: new Types.ObjectId(produtoId) })).toBe(0);
      expect(storage.assinaturas).toHaveLength(0);
    });

    it("produto inexistente e produto excluído retornam 404", async () => {
      expect((await erroApi(solicitar(new Types.ObjectId().toHexString()))).getStatus()).toBe(404);
      const produtoId = await novoProduto();
      await produtosService.excluir(produtoId, null);
      expect((await erroApi(solicitar(produtoId))).getStatus()).toBe(404);
      expect(storage.assinaturas).toHaveLength(0);
    });

    it("limite atingido (20 imagens / 3 vídeos) retorna 409; o limite é por tipo", async () => {
      const produtoId = await novoProduto();
      for (let i = 0; i < 20; i += 1) await inserirMidiaDiretamente(connection, produtoId, { ordem: i });
      const erro = await erroApi(solicitar(produtoId));
      expect(erro.getStatus()).toBe(409);
      expect(erro.message).toContain("20 imagens");
      // Vídeo ainda cabe.
      await solicitar(produtoId, { fileName: "v.mp4", contentType: "video/mp4", kind: "video" });
      for (let i = 0; i < 3; i += 1) await inserirMidiaDiretamente(connection, produtoId, { tipo: "video", ordem: 20 + i });
      expect((await erroApi(solicitar(produtoId, { fileName: "v.mp4", contentType: "video/mp4", kind: "video" }))).getStatus()).toBe(409);
    });

    it("storage indisponível ao assinar: 503 STORAGE_UNAVAILABLE e o registro vira descartado (a chave continua rastreada)", async () => {
      const produtoId = await novoProduto();
      storage.falhas.assinar = true;
      const erro = await erroApi(solicitar(produtoId));
      expect(erro.getStatus()).toBe(503);
      expect(erro.code).toBe("STORAGE_UNAVAILABLE");
      const registros = await uploads().find({ produtoId: new Types.ObjectId(produtoId) }).toArray();
      expect(registros).toHaveLength(1);
      expect(registros[0]!.estado).toBe("descartado");
    });
  });

  describe("confirmação de upload", () => {
    it("válida: inclui a mídia (id = uploadId, URL pública montada pelo backend) e marca o registro confirmado", async () => {
      const produtoId = await novoProduto();
      const { uploadId, chave } = await enviado(produtoId);
      const resposta = await confirmar(produtoId, uploadId);

      expect(resposta.midia._id).toBe(uploadId);
      expect(resposta.midia.url).toBe(`${BASE_PUBLICA}/${chave}`);
      expect(resposta.midia.chave).toBe(chave);
      expect(resposta.midia.origem).toBe("upload");
      expect(resposta.midia.tipo).toBe("image");
      expect(resposta.midia.contentType).toBe("image/jpeg");
      expect(resposta.midia.tamanho).toBe(1024);
      expect(resposta.midia.nomeOriginal).toBe("foto.jpg");
      expect(resposta.midia.ordem).toBe(0);
      expect(resposta.midia.varianteId).toBeNull();
      expect(resposta.midia.criadoPor).toBe("admin-teste");
      expect(resposta.midias.map((midia) => midia._id)).toEqual([uploadId]);
      // Sem principal marcada, a leitura usa a primeira imagem.
      expect(resposta.midiaPrincipalId).toBe(uploadId);
      expect((await produtoBruto(produtoId)).midiaPrincipalId).toBeNull();

      const doc = await registro(uploadId);
      expect(doc.estado).toBe("confirmado");
      expect(doc.confirmadoEm).toBeInstanceOf(Date);
      expect(storage.exclusoes).toHaveLength(0);
    });

    it("aceita os 5 formatos pela assinatura real (JPEG, PNG, GIF, WebP, MP4) e incrementa a ordem", async () => {
      const produtoId = await novoProduto();
      const ids: string[] = [];
      for (const formato of ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"]) ids.push(await confirmada(produtoId, {}, formato));
      const { midias } = await galeria.listar(produtoId);
      expect(midias.map((midia) => midia._id)).toEqual(ids);
      expect(midias.map((midia) => midia.ordem)).toEqual([0, 1, 2, 3, 4]);
      expect(midias[4]!.tipo).toBe("video");
    });

    it("principal: true define a imagem principal", async () => {
      const produtoId = await novoProduto();
      await confirmada(produtoId);
      const segunda = await confirmada(produtoId, { principal: true });
      expect((await produtoBruto(produtoId)).midiaPrincipalId).toBe(segunda);
      expect((await galeria.listar(produtoId)).midiaPrincipalId).toBe(segunda);
    });

    it("objeto inexistente, tamanho divergente, Content-Type divergente e assinatura inválida retornam 400 sem gravar", async () => {
      const produtoId = await novoProduto();
      const ausente = await solicitar(produtoId);
      const erroAusente = await erroApi(confirmar(produtoId, ausente.uploadId));
      expect(erroAusente.getStatus()).toBe(400);
      expect(erroAusente.message).toContain("não foi encontrado");

      const tamanho = await solicitar(produtoId);
      storage.enviar(storage.ultimaChave(), arquivoDoFormato("image/jpeg", 2048), "image/jpeg");
      expect((await erroApi(confirmar(produtoId, tamanho.uploadId))).errors[0]!.field).toBe("size");

      const tipo = await solicitar(produtoId);
      storage.enviar(storage.ultimaChave(), arquivoDoFormato("image/jpeg"), "text/html");
      expect((await erroApi(confirmar(produtoId, tipo.uploadId))).errors[0]!.field).toBe("contentType");

      // HTML disfarçado: Content-Type e tamanho batem, o conteúdo não.
      const disfarcado = await solicitar(produtoId, { fileName: "foto.png", contentType: "image/png" });
      storage.enviar(storage.ultimaChave(), arquivoDoFormato("text/html"), "image/png");
      const erroAssinatura = await erroApi(confirmar(produtoId, disfarcado.uploadId));
      expect(erroAssinatura.getStatus()).toBe(400);
      expect(erroAssinatura.message).toContain("não corresponde ao formato");

      expect((await produtoBruto(produtoId)).midias ?? []).toHaveLength(0);
      for (const { uploadId } of [ausente, tamanho, tipo, disfarcado]) expect((await registro(uploadId)).estado).toBe("pendente");
    });

    it("Content-Type com parâmetros/caixa diferente é normalizado antes da comparação", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await solicitar(produtoId);
      storage.enviar(storage.ultimaChave(), arquivoDoFormato("image/jpeg"), "Image/JPEG; charset=binary");
      expect((await confirmar(produtoId, uploadId)).midia._id).toBe(uploadId);
    });

    it("upload expirado (limpezaApos vencido) retorna 409; URL expirada com prazo do registro vigente ainda confirma", async () => {
      const produtoId = await novoProduto();
      const expirado = await enviado(produtoId);
      await uploads().updateOne({ _id: expirado.uploadId }, { $set: { limpezaApos: new Date(Date.now() - 1000) } });
      const erro = await erroApi(confirmar(produtoId, expirado.uploadId));
      expect(erro.getStatus()).toBe(409);
      expect(erro.message).toContain("expirado");
      expect((await registro(expirado.uploadId)).estado).toBe("pendente");

      const urlVencida = await enviado(produtoId);
      await uploads().updateOne({ _id: urlVencida.uploadId }, { $set: { urlExpiraEm: new Date(Date.now() - 1000) } });
      expect((await confirmar(produtoId, urlVencida.uploadId)).midia._id).toBe(urlVencida.uploadId);
    });

    it("upload de outro produto ou inexistente retorna 404", async () => {
      const produtoA = await novoProduto();
      const produtoB = await novoProduto();
      const { uploadId } = await enviado(produtoA);
      expect((await erroApi(confirmar(produtoB, uploadId))).getStatus()).toBe(404);
      expect((await erroApi(confirmar(produtoA, "00000000-0000-0000-0000-000000000000"))).getStatus()).toBe(404);
      expect((await produtoBruto(produtoB)).midias ?? []).toHaveLength(0);
      expect((await registro(uploadId)).estado).toBe("pendente");
    });

    it("variante inexistente ou de outro produto retorna 400; variante do produto associa", async () => {
      const produtoId = await novoProduto();
      const outro = await novoProduto();
      const varianteOutro = await novaVariante(outro);
      const variante = await novaVariante(produtoId);

      const a = await enviado(produtoId);
      expect((await erroApi(confirmar(produtoId, a.uploadId, { varianteId: new Types.ObjectId().toHexString() }))).getStatus()).toBe(400);
      expect((await erroApi(confirmar(produtoId, a.uploadId, { varianteId: varianteOutro }))).getStatus()).toBe(400);
      expect((await registro(a.uploadId)).estado).toBe("pendente");

      const resposta = await confirmar(produtoId, a.uploadId, { varianteId: variante });
      expect(String(resposta.midia.varianteId)).toBe(variante);
    });

    it("vídeo não aceita variante nem principal (400)", async () => {
      const produtoId = await novoProduto();
      const variante = await novaVariante(produtoId);
      const { uploadId } = await enviado(produtoId, "video/mp4");
      expect((await erroApi(confirmar(produtoId, uploadId, { varianteId: variante }))).getStatus()).toBe(400);
      expect((await erroApi(confirmar(produtoId, uploadId, { principal: true }))).getStatus()).toBe(400);
      expect((await confirmar(produtoId, uploadId)).midia.tipo).toBe("video");
    });

    it("confirmação repetida não duplica a mídia e devolve o mesmo resultado", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await enviado(produtoId);
      const primeira = await confirmar(produtoId, uploadId);
      const segunda = await confirmar(produtoId, uploadId);
      expect(segunda.midia._id).toBe(primeira.midia._id);
      expect(await idsDaGaleria(produtoId)).toEqual([uploadId]);
      expect((await registro(uploadId)).estado).toBe("confirmado");
    });

    it("duas confirmações concorrentes do mesmo upload: ambas concluem e a mídia entra uma única vez", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await enviado(produtoId);
      const pontos = [novoPonto(), novoPonto()];
      let chamada = 0;
      const lerOriginal = storage.lerPrimeirosBytes.bind(storage);
      const espiao = spyOn(storage, "lerPrimeirosBytes").mockImplementation(async (key: string, quantidade: number) => {
        const ponto = pontos[chamada];
        chamada += 1;
        const bytes = await lerOriginal(key, quantidade);
        if (ponto) {
          ponto.chegou.liberar();
          await ponto.liberacao.promessa;
        }
        return bytes;
      });
      try {
        const a = confirmar(produtoId, uploadId);
        const b = confirmar(produtoId, uploadId);
        // As duas já validaram o objeto e vão escrever ao mesmo tempo.
        await Promise.all(pontos.map((ponto) => ponto.chegou.promessa));
        liberarTudo(...pontos);
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra.midia._id).toBe(uploadId);
        expect(rb.midia._id).toBe(uploadId);
      } finally {
        liberarTudo(...pontos);
        espiao.mockRestore();
      }
      expect(await idsDaGaleria(produtoId)).toEqual([uploadId]);
      expect((await registro(uploadId)).estado).toBe("confirmado");
    });

    it("falha de storage na verificação: 503 sem gravar mídia; o registro continua pendente e a nova tentativa funciona", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await enviado(produtoId);
      for (const falha of ["inspecionar", "ler"] as const) {
        storage.falhas[falha] = true;
        const erro = await erroApi(confirmar(produtoId, uploadId));
        expect(erro.code).toBe("STORAGE_UNAVAILABLE");
        storage.falhas[falha] = false;
      }
      expect((await produtoBruto(produtoId)).midias ?? []).toHaveLength(0);
      expect((await registro(uploadId)).estado).toBe("pendente");
      expect((await confirmar(produtoId, uploadId)).midia._id).toBe(uploadId);
    });

    it("falha genérica de uma implementação de storage também vira STORAGE_UNAVAILABLE", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await enviado(produtoId);
      const espiao = spyOn(storage, "inspecionarObjeto").mockImplementation(async () => {
        throw new Error("ECONNRESET");
      });
      try {
        expect((await erroApi(confirmar(produtoId, uploadId))).code).toBe("STORAGE_UNAVAILABLE");
      } finally {
        espiao.mockRestore();
      }
    });

    it("produto gravado mas falha ao marcar o registro: responde sucesso, e a nova confirmação reconcilia sem duplicar", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await enviado(produtoId);
      const espiao = spyOn(uploadsRepository, "marcarConfirmado").mockImplementationOnce(async () => {
        throw new Error("falha simulada do MongoDB");
      });
      try {
        expect((await confirmar(produtoId, uploadId)).midia._id).toBe(uploadId);
      } finally {
        espiao.mockRestore();
      }
      expect(await idsDaGaleria(produtoId)).toEqual([uploadId]);
      // Fase 60.3.1 — fica com a reserva da confirmação (`confirmando`), que a limpeza nunca toca.
      expect((await registro(uploadId)).estado).toBe("confirmando");

      // Recuperação idempotente: reconhece que o produto já referencia a mídia e só conclui o registro.
      storage.falhas.inspecionar = true; // nem precisa do storage para reconciliar
      expect((await confirmar(produtoId, uploadId)).midia._id).toBe(uploadId);
      expect(await idsDaGaleria(produtoId)).toEqual([uploadId]);
      expect((await registro(uploadId)).estado).toBe("confirmado");
    });

    it("reconciliação × remoção concorrente: o registro já removido nunca volta a confirmado", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await enviado(produtoId);
      // 1ª confirmação grava o produto mas não marca o registro (falha parcial).
      const falha = spyOn(uploadsRepository, "marcarConfirmado").mockImplementationOnce(async () => {
        throw new Error("falha simulada do MongoDB");
      });
      try {
        await confirmar(produtoId, uploadId);
      } finally {
        falha.mockRestore();
      }
      // A retomada pausa logo antes de marcar o registro; nesse intervalo a mídia é removida (registro → removido).
      const ponto = novoPonto();
      const marcarOriginal = uploadsRepository.marcarConfirmado.bind(uploadsRepository);
      const pausa = spyOn(uploadsRepository, "marcarConfirmado").mockImplementation(async (id: string, em: Date) => {
        ponto.chegou.liberar();
        await ponto.liberacao.promessa;
        return marcarOriginal(id, em);
      });
      try {
        const retomada = confirmar(produtoId, uploadId);
        await ponto.chegou.promessa;
        pausa.mockRestore();
        await galeria.remover(produtoId, uploadId);
        expect((await registro(uploadId)).estado).toBe("removido");
        ponto.liberacao.liberar();
        await retomada;
      } finally {
        liberarTudo(ponto);
        pausa.mockRestore();
      }
      expect((await registro(uploadId)).estado).toBe("removido");
      expect(await idsDaGaleria(produtoId)).toEqual([]);
    });

    it("objeto validado mas a escrita no produto falha (conflito esgotado): 409, nada gravado, registro pendente, nova tentativa funciona", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await enviado(produtoId);
      const { resultado, tentativas } = await executarComConflitosDeVersao(
        produtosRepository,
        3,
        () => confirmar(produtoId, uploadId),
        () => produtosBrutos().updateOne({ _id: new Types.ObjectId(produtoId) }, { $inc: { __v: 1 } }),
      );
      expect(tentativas).toBe(3);
      const erro = erroDe(resultado);
      expect(erro).toBeInstanceOf(ApiException);
      expect((erro as ApiException).getStatus()).toBe(409);
      expect((await produtoBruto(produtoId)).midias ?? []).toHaveLength(0);
      expect((await registro(uploadId)).estado).toBe("pendente");
      expect((await confirmar(produtoId, uploadId)).midia._id).toBe(uploadId);
    });

    it("produto excluído durante a operação: 404, nada gravado e registro pendente", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await enviado(produtoId);
      const ponto = novoPonto();
      const lerOriginal = storage.lerPrimeirosBytes.bind(storage);
      const espiao = spyOn(storage, "lerPrimeirosBytes").mockImplementation(async (key: string, quantidade: number) => {
        const bytes = await lerOriginal(key, quantidade);
        ponto.chegou.liberar();
        await ponto.liberacao.promessa;
        return bytes;
      });
      try {
        const operacao = erroApi(confirmar(produtoId, uploadId));
        await ponto.chegou.promessa;
        await produtosService.excluir(produtoId, null);
        ponto.liberacao.liberar();
        expect((await operacao).getStatus()).toBe(404);
      } finally {
        liberarTudo(ponto);
        espiao.mockRestore();
      }
      const bruto = await produtoBruto(produtoId);
      expect(bruto.excluidoEm).toBeInstanceOf(Date);
      expect(bruto.midias ?? []).toHaveLength(0);
      expect((await registro(uploadId)).estado).toBe("pendente");
    });

    it("upload removido ou descartado não pode ser confirmado (409)", async () => {
      const produtoId = await novoProduto();
      const removido = await confirmada(produtoId);
      await galeria.remover(produtoId, removido);
      expect((await erroApi(confirmar(produtoId, removido))).getStatus()).toBe(409);

      storage.falhas.assinar = true;
      await erroApi(solicitar(produtoId));
      storage.falhas.assinar = false;
      const descartado = (await uploads().findOne({ produtoId: new Types.ObjectId(produtoId), estado: "descartado" }))!;
      expect((await erroApi(confirmar(produtoId, descartado._id))).getStatus()).toBe(409);
      expect(await idsDaGaleria(produtoId)).toEqual([]);
    });

    it("limite conferido também na confirmação: dois uploads novos autorizados com 19 imagens — só o primeiro entra (409, registro pendente)", async () => {
      const produtoId = await novoProduto();
      for (let i = 0; i < 19; i += 1) await inserirMidiaDiretamente(connection, produtoId, { ordem: i });
      const a = await enviado(produtoId);
      const b = await enviado(produtoId);
      await confirmar(produtoId, a.uploadId); // 20 imagens
      expect((await erroApi(confirmar(produtoId, b.uploadId))).getStatus()).toBe(409);
      expect((await registro(b.uploadId)).estado).toBe("pendente");
      expect(await idsDaGaleria(produtoId)).toHaveLength(20);
    });

    it("dois uploads novos CONCORRENTES com 19 imagens: o limite é revalidado na mutação e só um entra", async () => {
      const produtoId = await novoProduto();
      for (let i = 0; i < 19; i += 1) await inserirMidiaDiretamente(connection, produtoId, { ordem: i });
      const a = await enviado(produtoId);
      const b = await enviado(produtoId);
      const resultados = await emParalelo([() => confirmar(produtoId, a.uploadId), () => confirmar(produtoId, b.uploadId)]);
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejeitado = resultados.find((r) => r.status === "rejected");
      expect(rejeitado?.status === "rejected" && rejeitado.reason instanceof ApiException && rejeitado.reason.getStatus()).toBe(409);
      expect(await idsDaGaleria(produtoId)).toHaveLength(20);
    });
  });

  describe("substituição (Fase 60.1.1 — intenção registrada na solicitação)", () => {
    it("galeria cheia: upload novo é 409, substituição do mesmo tipo é autorizada e o registro guarda o alvo", async () => {
      const produtoId = await novoProduto();
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1) ids.push(await inserirMidiaDiretamente(connection, produtoId, { ordem: i }));
      expect((await erroApi(solicitar(produtoId))).getStatus()).toBe(409);

      const autorizado = await solicitar(produtoId, { substituiMidiaId: ids[3]! });
      expect(Object.keys(autorizado).sort()).toEqual(["expiresIn", "headers", "method", "uploadId", "uploadUrl"]);
      expect((await registro(autorizado.uploadId)).substituiMidiaId).toBe(ids[3]!);
      // Upload novo grava o alvo como null.
      const outroProduto = await novoProduto();
      expect((await registro((await solicitar(outroProduto)).uploadId)).substituiMidiaId).toBeNull();
    });

    it("confirmar substituição com a galeria cheia: herda a ordem e a galeria continua com 20", async () => {
      const produtoId = await novoProduto();
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1) ids.push(await inserirMidiaDiretamente(connection, produtoId, { ordem: i }));
      const { uploadId } = await enviado(produtoId, "image/jpeg", 1024, ids[7]!);
      const resposta = await confirmar(produtoId, uploadId); // corpo sem substituiMidiaId: vale o registrado
      expect(resposta.midias).toHaveLength(20);
      expect(resposta.midia.ordem).toBe(7);
      expect(resposta.midias.map((midia) => midia._id)).not.toContain(ids[7]!);
      expect(resposta.midias[7]!._id).toBe(uploadId);
    });

    it("abaixo do limite: herda ordem, variante e principal na mesma escrita; registro antigo removido; objeto preservado", async () => {
      const produtoId = await novoProduto();
      const variante = await novaVariante(produtoId);
      const primeira = await confirmada(produtoId);
      const antiga = await confirmada(produtoId, { varianteId: variante, principal: true });
      const terceira = await confirmada(produtoId);
      const antes = await produtoBruto(produtoId);

      const { uploadId: nova } = await enviado(produtoId, "image/png", 1024, antiga);
      const resposta = await confirmar(produtoId, nova, { substituiMidiaId: antiga }); // repetir o alvo é aceito

      expect(resposta.midias.map((midia) => midia._id)).toEqual([primeira, nova, terceira]);
      expect(resposta.midia.ordem).toBe(1);
      expect(String(resposta.midia.varianteId)).toBe(variante);
      expect(resposta.midiaPrincipalId).toBe(nova);
      const depois = await produtoBruto(produtoId);
      expect(depois.midiaPrincipalId).toBe(nova);
      expect(depois.__v).toBe(antes.__v + 1); // uma única escrita
      expect((await registro(antiga)).estado).toBe("removido");
      expect((await registro(antiga)).removidoEm).toBeInstanceOf(Date);
      expect((await registro(nova)).estado).toBe("confirmado");
      expect(storage.exclusoes).toHaveLength(0);
    });

    it("vídeo por vídeo com 3 vídeos: autorizado e confirmado sem passar do limite; vídeo nunca vira principal", async () => {
      const produtoId = await novoProduto();
      const imagem = await confirmada(produtoId);
      const videos: string[] = [];
      for (let i = 0; i < 3; i += 1) videos.push(await confirmada(produtoId, {}, "video/mp4"));
      const { uploadId } = await enviado(produtoId, "video/mp4", 1024, videos[1]!);
      const resposta = await confirmar(produtoId, uploadId);
      expect(resposta.midias.filter((midia) => midia.tipo === "video").map((midia) => midia._id)).toEqual([videos[0]!, uploadId, videos[2]!]);
      expect(resposta.midiaPrincipalId).toBe(imagem);
    });

    it("alvo de outro produto, já removido ou inexistente: 404 na solicitação, sem registro nem assinatura", async () => {
      const produtoId = await novoProduto();
      const outro = await novoProduto();
      const deOutro = await confirmada(outro);
      const removida = await confirmada(produtoId);
      await galeria.remover(produtoId, removida);
      storage.reiniciar();
      const antes = await uploads().countDocuments({ produtoId: new Types.ObjectId(produtoId) });
      for (const alvo of [deOutro, removida, "nao-existe"]) {
        expect((await erroApi(solicitar(produtoId, { substituiMidiaId: alvo }))).getStatus()).toBe(404);
      }
      expect(await uploads().countDocuments({ produtoId: new Types.ObjectId(produtoId) })).toBe(antes);
      expect(storage.assinaturas).toHaveLength(0);
    });

    it("tipos diferentes são recusados (400): imagem não substitui vídeo para liberar vaga de imagem, nem vídeo substitui imagem", async () => {
      const produtoId = await novoProduto();
      const imagens: string[] = [];
      for (let i = 0; i < 20; i += 1) imagens.push(await inserirMidiaDiretamente(connection, produtoId, { ordem: i }));
      const video = await inserirMidiaDiretamente(connection, produtoId, { tipo: "video", ordem: 20 });

      const imagemPorVideo = await erroApi(solicitar(produtoId, { substituiMidiaId: video }));
      expect(imagemPorVideo.getStatus()).toBe(400);
      expect(imagemPorVideo.errors[0]!.field).toBe("substituiMidiaId");
      const videoPorImagem = await erroApi(solicitar(produtoId, { fileName: "v.mp4", contentType: "video/mp4", kind: "video", substituiMidiaId: imagens[0]! }));
      expect(videoPorImagem.getStatus()).toBe(400);
      expect(await idsDaGaleria(produtoId)).toHaveLength(21);
    });

    it("a confirmação não troca o alvo nem introduz substituição (409); repetir o alvo registrado funciona", async () => {
      const produtoId = await novoProduto();
      const a = await confirmada(produtoId);
      const b = await confirmada(produtoId);
      const comAlvo = await enviado(produtoId, "image/jpeg", 1024, a);
      const trocado = await erroApi(confirmar(produtoId, comAlvo.uploadId, { substituiMidiaId: b }));
      expect(trocado.getStatus()).toBe(409);
      expect(trocado.message).toContain("diferente do registrado");

      const semAlvo = await enviado(produtoId);
      const introduzido = await erroApi(confirmar(produtoId, semAlvo.uploadId, { substituiMidiaId: a }));
      expect(introduzido.getStatus()).toBe(409);
      expect(introduzido.message).toContain("sem substituição");

      expect(await idsDaGaleria(produtoId)).toEqual([a, b]);
      expect((await registro(comAlvo.uploadId)).estado).toBe("pendente");
      expect((await registro(semAlvo.uploadId)).estado).toBe("pendente");
      expect((await confirmar(produtoId, comAlvo.uploadId, { substituiMidiaId: a })).midias.map((midia) => midia._id)).toEqual([comAlvo.uploadId, b]);
    });

    it("a confirmação revalida o tipo do alvo na mutação (não confia só na solicitação): alvo adulterado para um vídeo → 409, galeria intacta", async () => {
      const produtoId = await novoProduto();
      const imagem = await confirmada(produtoId);
      const video = await confirmada(produtoId, {}, "video/mp4");
      const { uploadId } = await enviado(produtoId, "image/jpeg", 1024, imagem);
      await uploads().updateOne({ _id: uploadId }, { $set: { substituiMidiaId: video } });
      const antes = await produtoBruto(produtoId);
      const erro = await erroApi(confirmar(produtoId, uploadId));
      expect(erro.getStatus()).toBe(409);
      expect(erro.message).toContain("mesmo tipo");
      expect((await produtoBruto(produtoId)).__v).toBe(antes.__v);
      expect(await idsDaGaleria(produtoId)).toEqual([imagem, video]);
      expect((await registro(uploadId)).estado).toBe("pendente");
    });

    it("compatibilidade: registro pendente anterior, sem o campo, confirma como upload novo", async () => {
      const produtoId = await novoProduto();
      const a = await confirmada(produtoId);
      const { uploadId } = await enviado(produtoId);
      await uploads().updateOne({ _id: uploadId }, { $unset: { substituiMidiaId: "" } });
      expect((await confirmar(produtoId, uploadId)).midias.map((midia) => midia._id)).toEqual([a, uploadId]);
    });

    it("alvo removido entre a solicitação e a confirmação: 409 controlado, galeria intacta, registro pendente", async () => {
      const produtoId = await novoProduto();
      const a = await confirmada(produtoId);
      const b = await confirmada(produtoId);
      const { uploadId } = await enviado(produtoId, "image/jpeg", 1024, a);
      await galeria.remover(produtoId, a);
      const antes = await produtoBruto(produtoId);
      const erro = await erroApi(confirmar(produtoId, uploadId));
      expect(erro.getStatus()).toBe(409);
      expect(erro.message).toContain("não está mais na galeria");
      const depois = await produtoBruto(produtoId);
      expect(depois.__v).toBe(antes.__v);
      expect(await idsDaGaleria(produtoId)).toEqual([b]);
      expect((await registro(uploadId)).estado).toBe("pendente");
    });

    it("duas solicitações concorrentes para o mesmo alvo: ambas autorizadas; nas confirmações simultâneas uma vence e a outra recebe 409", async () => {
      const produtoId = await novoProduto();
      const alvo = await confirmada(produtoId);
      const outra = await confirmada(produtoId);
      const [s1, s2] = await Promise.all([solicitar(produtoId, { substituiMidiaId: alvo }), solicitar(produtoId, { substituiMidiaId: alvo })]);
      for (const { uploadId } of [s1, s2]) {
        storage.enviar(`products/${produtoId}/${uploadId}.jpg`, arquivoDoFormato("image/jpeg"), "image/jpeg");
        expect((await registro(uploadId)).substituiMidiaId).toBe(alvo);
      }
      const resultados = await emParalelo([() => confirmar(produtoId, s1.uploadId), () => confirmar(produtoId, s2.uploadId)]);
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejeitado = resultados.find((r) => r.status === "rejected");
      expect(rejeitado?.status === "rejected" && rejeitado.reason instanceof ApiException && rejeitado.reason.getStatus()).toBe(409);

      const ids = await idsDaGaleria(produtoId);
      expect(ids).toHaveLength(2);
      expect(ids[1]).toBe(outra);
      const vencedor = ids[0]!;
      expect([s1.uploadId, s2.uploadId]).toContain(vencedor);
      const perdedor = vencedor === s1.uploadId ? s2.uploadId : s1.uploadId;
      expect((await registro(perdedor)).estado).toBe("pendente");
      expect((await registro(alvo)).estado).toBe("removido");
    });

    it("duas substituições diferentes concorrentes com a galeria cheia: ambas concluem e o limite continua em 20", async () => {
      const produtoId = await novoProduto();
      const ids: string[] = [];
      for (let i = 0; i < 20; i += 1) ids.push(await inserirMidiaDiretamente(connection, produtoId, { ordem: i }));
      const x = await enviado(produtoId, "image/jpeg", 1024, ids[2]!);
      const y = await enviado(produtoId, "image/jpeg", 1024, ids[15]!);
      const resultados = await emParalelo([() => confirmar(produtoId, x.uploadId), () => confirmar(produtoId, y.uploadId)]);
      expect(resultados.every((r) => r.status === "fulfilled")).toBe(true);
      const final = await galeria.listar(produtoId);
      expect(final.midias).toHaveLength(20);
      expect(final.midias[2]!._id).toBe(x.uploadId);
      expect(final.midias[15]!._id).toBe(y.uploadId);
      expect(final.midias.map((midia) => midia._id)).not.toContain(ids[2]!);
      expect(final.midias.map((midia) => midia._id)).not.toContain(ids[15]!);
    });

    it("varianteId explícito na confirmação prevalece sobre a variante herdada", async () => {
      const produtoId = await novoProduto();
      const azul = await novaVariante(produtoId, "Azul");
      const preto = await novaVariante(produtoId, "Preto");
      const antiga = await confirmada(produtoId, { varianteId: azul });
      const { uploadId: nova } = await enviado(produtoId, "image/jpeg", 1024, antiga);
      expect(String((await confirmar(produtoId, nova, { varianteId: preto })).midia.varianteId)).toBe(preto);
    });

    it("falha parcial (registro antigo não marcado): a repetição conclui a remoção do substituído e é idempotente", async () => {
      const produtoId = await novoProduto();
      const antiga = await confirmada(produtoId);
      const { uploadId: nova } = await enviado(produtoId, "image/jpeg", 1024, antiga);
      const espiao = spyOn(uploadsRepository, "marcarRemovido").mockImplementationOnce(async () => {
        throw new Error("falha simulada do MongoDB");
      });
      try {
        await confirmar(produtoId, nova);
      } finally {
        espiao.mockRestore();
      }
      expect((await registro(antiga)).estado).toBe("confirmado");
      await confirmar(produtoId, nova);
      expect((await registro(antiga)).estado).toBe("removido");
      await confirmar(produtoId, nova);
      expect(await idsDaGaleria(produtoId)).toEqual([nova]);
      expect((await registro(nova)).estado).toBe("confirmado");
    });
  });

  describe("galeria", () => {
    it("consulta: mídias pela ordem e principal com fallback para a primeira imagem (vídeo nunca é principal)", async () => {
      const produtoId = await novoProduto();
      const video = await inserirMidiaDiretamente(connection, produtoId, { tipo: "video", ordem: 0 });
      const b = await inserirMidiaDiretamente(connection, produtoId, { ordem: 2 });
      const a = await inserirMidiaDiretamente(connection, produtoId, { ordem: 1 });
      const consulta = await galeria.listar(produtoId);
      expect(consulta.midias.map((midia) => midia._id)).toEqual([video, a, b]);
      expect(consulta.midiaPrincipalId).toBe(a);
    });

    it("produto antigo sem os campos da galeria: consulta vazia, sem erro", async () => {
      const produtoId = await novoProduto();
      await produtosBrutos().updateOne({ _id: new Types.ObjectId(produtoId) }, { $unset: { midias: "", midiaPrincipalId: "" } });
      expect(await galeria.listar(produtoId)).toEqual({ midias: [], midiaPrincipalId: null });
      expect((await confirmar(produtoId, (await enviado(produtoId)).uploadId)).midias).toHaveLength(1);
    });

    it("definir principal: aceita imagem do produto; rejeita vídeo (400) e mídia inexistente (404)", async () => {
      const produtoId = await novoProduto();
      await confirmada(produtoId);
      const segunda = await confirmada(produtoId);
      const video = await confirmada(produtoId, {}, "video/mp4");
      expect((await galeria.definirPrincipal(produtoId, segunda)).midiaPrincipalId).toBe(segunda);
      expect((await erroApi(galeria.definirPrincipal(produtoId, video))).getStatus()).toBe(400);
      expect((await erroApi(galeria.definirPrincipal(produtoId, "nao-existe"))).getStatus()).toBe(404);
      expect((await produtoBruto(produtoId)).midiaPrincipalId).toBe(segunda);
    });

    it("reordenar: lista válida regrava todas as ordens numa escrita; incompleta, com adicional ou duplicada é 400", async () => {
      const produtoId = await novoProduto();
      const a = await confirmada(produtoId);
      const b = await confirmada(produtoId);
      const c = await confirmada(produtoId, {}, "video/mp4");
      const antes = await produtoBruto(produtoId);
      const resposta = await galeria.reordenar(produtoId, [c, a, b]);
      expect(resposta.midias.map((midia) => [midia._id, midia.ordem])).toEqual([[c, 0], [a, 1], [b, 2]]);
      expect((await produtoBruto(produtoId)).__v).toBe(antes.__v + 1);

      for (const lista of [[a, b], [a, b, c, "extra"], [a, a, b, c], [a, b, "outro"]]) {
        expect((await erroApi(galeria.reordenar(produtoId, lista))).getStatus()).toBe(400);
      }
      expect(await idsDaGaleria(produtoId)).toEqual([c, a, b]);
    });

    it("associar imagem a variante, desassociar; vídeo e variante inexistente rejeitados (400)", async () => {
      const produtoId = await novoProduto();
      const variante = await novaVariante(produtoId);
      const imagem = await confirmada(produtoId);
      const video = await confirmada(produtoId, {}, "video/mp4");

      let resposta = await galeria.associarVariante(produtoId, imagem, variante);
      expect(String(resposta.midias.find((midia) => midia._id === imagem)!.varianteId)).toBe(variante);
      resposta = await galeria.associarVariante(produtoId, imagem, null);
      expect(resposta.midias.find((midia) => midia._id === imagem)!.varianteId).toBeNull();

      expect((await erroApi(galeria.associarVariante(produtoId, video, variante))).getStatus()).toBe(400);
      expect((await erroApi(galeria.associarVariante(produtoId, imagem, new Types.ObjectId().toHexString()))).getStatus()).toBe(400);
      expect((await erroApi(galeria.associarVariante(produtoId, "nao-existe", null))).getStatus()).toBe(404);
    });

    it("remover a principal: sai da galeria, a principal gravada é limpa (leitura cai na próxima imagem), registro removido, objeto preservado", async () => {
      const produtoId = await novoProduto();
      const a = await confirmada(produtoId, { principal: true });
      const b = await confirmada(produtoId);
      const resposta = await galeria.remover(produtoId, a);
      expect(resposta.midias.map((midia) => midia._id)).toEqual([b]);
      expect(resposta.midiaPrincipalId).toBe(b);
      expect((await produtoBruto(produtoId)).midiaPrincipalId).toBeNull();
      expect((await registro(a)).estado).toBe("removido");
      expect(storage.exclusoes).toHaveLength(0);
      expect(storage.objetos.size).toBe(2);
      expect((await erroApi(galeria.remover(produtoId, a))).getStatus()).toBe(404);
    });

    it("remover mídia legada sem registro de upload: sai da galeria e nenhum registro é criado", async () => {
      const produtoId = await novoProduto();
      const legada = await inserirMidiaDiretamente(connection, produtoId, { origem: "legado" });
      await galeria.definirPrincipal(produtoId, legada);
      const resposta = await galeria.remover(produtoId, legada);
      expect(resposta).toEqual({ midias: [], midiaPrincipalId: null });
      expect(await uploads().countDocuments({ _id: legada })).toBe(0);
    });

    it("remoção que gravou o produto mas falhou ao marcar o registro: repetir o DELETE conclui a marcação", async () => {
      const produtoId = await novoProduto();
      const a = await confirmada(produtoId);
      const espiao = spyOn(uploadsRepository, "marcarRemovido").mockImplementationOnce(async () => {
        throw new Error("falha simulada do MongoDB");
      });
      try {
        await galeria.remover(produtoId, a);
      } finally {
        espiao.mockRestore();
      }
      expect((await registro(a)).estado).toBe("confirmado");
      expect((await galeria.remover(produtoId, a)).midias).toEqual([]);
      expect((await registro(a)).estado).toBe("removido");
    });

    it("remover variante desassocia suas imagens na mesma escrita, sem removê-las", async () => {
      const produtoId = await novoProduto();
      const azul = await novaVariante(produtoId, "Azul");
      const preto = await novaVariante(produtoId, "Preto");
      const daAzul = await confirmada(produtoId, { varianteId: azul });
      const daPreta = await confirmada(produtoId, { varianteId: preto });
      const antes = await produtoBruto(produtoId);
      await produtosService.removerVariante(produtoId, azul, null);
      const depois = await produtoBruto(produtoId);
      expect(depois.__v).toBe(antes.__v + 1);
      expect(depois.midias!.map((midia) => [midia._id, midia.varianteId === null ? null : String(midia.varianteId)])).toEqual([
        [daAzul, null],
        [daPreta, preto],
      ]);
    });
  });

  describe("concorrência (barreiras determinísticas, conflitos reais de versão)", () => {
    it("confirmação × remoção da variante: a confirmação refaz a mutação, encontra a variante removida e recusa (400) sem gravar", async () => {
      const produtoId = await novoProduto();
      const variante = await novaVariante(produtoId);
      const { uploadId } = await enviado(produtoId);
      const { resultado, tentativas } = await executarComConflitosDeVersao(
        produtosRepository,
        1,
        () => confirmar(produtoId, uploadId, { varianteId: variante }),
        () => produtosService.removerVariante(produtoId, variante, null),
      );
      expect(tentativas).toBe(2);
      expect((erroDe(resultado) as ApiException).getStatus()).toBe(400);
      expect(await idsDaGaleria(produtoId)).toEqual([]);
      expect((await registro(uploadId)).estado).toBe("pendente");
    });

    it("reordenação × remoção de mídia: a reordenação refeita vê o conjunto novo e recusa (400); a remoção prevalece", async () => {
      const produtoId = await novoProduto();
      const a = await confirmada(produtoId);
      const b = await confirmada(produtoId);
      const c = await confirmada(produtoId);
      const { resultado } = await executarComConflitosDeVersao(
        produtosRepository,
        1,
        () => galeria.reordenar(produtoId, [c, b, a]),
        () => galeria.remover(produtoId, b),
      );
      expect((erroDe(resultado) as ApiException).getStatus()).toBe(400);
      const final = await galeria.listar(produtoId);
      expect(final.midias.map((midia) => [midia._id, midia.ordem])).toEqual([[a, 0], [c, 2]]);
      expect((await registro(b)).estado).toBe("removido");
    });

    it("definição de principal × remoção da mesma mídia: a principal refeita não encontra a mídia (404) e nada aponta para ela", async () => {
      const produtoId = await novoProduto();
      const a = await confirmada(produtoId);
      const b = await confirmada(produtoId);
      const { resultado } = await executarComConflitosDeVersao(
        produtosRepository,
        1,
        () => galeria.definirPrincipal(produtoId, b),
        () => galeria.remover(produtoId, b),
      );
      expect((erroDe(resultado) as ApiException).getStatus()).toBe(404);
      const bruto = await produtoBruto(produtoId);
      expect(bruto.midiaPrincipalId ?? null).toBeNull();
      expect((await galeria.listar(produtoId)).midiaPrincipalId).toBe(a);
    });

    it("remoção × definição de principal da mesma mídia: a remoção refeita remove e limpa a principal recém-gravada", async () => {
      const produtoId = await novoProduto();
      await confirmada(produtoId);
      const b = await confirmada(produtoId);
      const { resultado } = await executarComConflitosDeVersao(
        produtosRepository,
        1,
        () => galeria.remover(produtoId, b),
        () => galeria.definirPrincipal(produtoId, b),
      );
      expect(resultado.ok).toBe(true);
      expect((await produtoBruto(produtoId)).midiaPrincipalId).toBeNull();
      expect(await idsDaGaleria(produtoId)).not.toContain(b);
    });

    it("esgotamento de retentativas numa mutação da galeria responde 409 CONFLICT e não grava", async () => {
      const produtoId = await novoProduto();
      await confirmada(produtoId);
      const b = await confirmada(produtoId);
      const { resultado, tentativas } = await executarComConflitosDeVersao(
        produtosRepository,
        3,
        () => galeria.definirPrincipal(produtoId, b),
        () => produtosBrutos().updateOne({ _id: new Types.ObjectId(produtoId) }, { $inc: { __v: 1 } }),
      );
      expect(tentativas).toBe(3);
      const erro = erroDe(resultado) as ApiException;
      expect(erro.getStatus()).toBe(409);
      expect(erro.code).toBe("CONFLICT");
      expect((await produtoBruto(produtoId)).midiaPrincipalId ?? null).toBeNull();
    });

    it("exclusão de produto (agora por salvarComRetentativa) × mutação da galeria: refaz e conclui, preservando a galeria", async () => {
      const produtoId = await novoProduto();
      const a = await confirmada(produtoId);
      const { resultado, tentativas } = await executarComConflitosDeVersao(
        produtosRepository,
        1,
        () => produtosService.excluir(produtoId, null),
        () => galeria.definirPrincipal(produtoId, a),
      );
      expect(resultado.ok).toBe(true);
      expect(tentativas).toBe(2);
      const bruto = await produtoBruto(produtoId);
      expect(bruto.excluidoEm).toBeInstanceOf(Date);
      expect(bruto.midiaPrincipalId).toBe(a);
      expect(bruto.midias!.map((midia) => midia._id)).toEqual([a]);
      expect((await erroApi(galeria.listar(produtoId))).getStatus()).toBe(404);
    });

    it("exclusão de produto com retentativas esgotadas responde 409 e o produto continua ativo", async () => {
      const produtoId = await novoProduto();
      const { resultado } = await executarComConflitosDeVersao(
        produtosRepository,
        3,
        () => produtosService.excluir(produtoId, null),
        () => produtosBrutos().updateOne({ _id: new Types.ObjectId(produtoId) }, { $inc: { __v: 1 } }),
      );
      expect((erroDe(resultado) as ApiException).getStatus()).toBe(409);
      expect((await produtoBruto(produtoId)).excluidoEm).toBeNull();
    });
  });

  describe("validação estrutural na confirmação (Fase 60.4.3.4.1)", () => {
    /** Solicita com o tamanho exato do conteúdo e simula o PUT. */
    async function enviadoComConteudo(produtoId: string, formato: string, conteudo: Uint8Array): Promise<string> {
      const { uploadId } = await solicitar(produtoId, {
        fileName: NOME_POR_FORMATO[formato]!,
        contentType: formato,
        kind: formato.startsWith("video") ? "video" : "image",
        size: conteudo.length,
      });
      storage.enviar(storage.ultimaChave(), conteudo, formato);
      return uploadId;
    }
    async function semEfeito(produtoId: string, uploadId: string): Promise<void> {
      expect((await produtoBruto(produtoId)).midias ?? []).toHaveLength(0);
      expect((await registro(uploadId)).estado).toBe("pendente");
      expect(storage.exclusoes).toHaveLength(0);
    }

    it("N8: JPEG com assinatura válida e conteúdo corrompido é recusado com 400 VALIDATION_ERROR (campo arquivo) e nada entra na galeria", async () => {
      const produtoId = await novoProduto();
      const uploadId = await enviadoComConteudo(produtoId, "image/jpeg", fixtureDeMidia(FIXTURES_MIDIA.n8));
      const erro = await erroApi(confirmar(produtoId, uploadId));
      expect(erro.getStatus()).toBe(400);
      expect(erro.code).toBe("VALIDATION_ERROR");
      expect(erro.errors).toEqual([{ field: "arquivo", message: "O arquivo está corrompido ou incompleto." }]);
      // Nenhum detalhe interno (offset, nome de marcador) chega ao cliente.
      expect(JSON.stringify(erro.getResponse())).not.toContain("offset");
      await semEfeito(produtoId, uploadId);
    });

    it("animação, quadros, dados extras e codec recusados com a mensagem pública do motivo", async () => {
      const produtoId = await novoProduto();
      const png = fixtureDeMidia(FIXTURES_MIDIA.png);
      const apng = new Uint8Array(Buffer.concat([png.subarray(0, 33), chunkPng("acTL", new Uint8Array(8)), png.subarray(33)]));
      const casos: [string, Uint8Array, string][] = [
        ["image/png", apng, "APNG"],
        ["image/png", new Uint8Array(Buffer.concat([png, Buffer.from("lixo-anexado")])), "dados adicionais"],
        ["video/mp4", mp4Sintetico({ codecVideo: "hvc1" }), "H.264"],
        ["video/mp4", mp4Sintetico({ duracaoVideoSegundos: 31 }), "30 segundos"],
      ];
      for (const [formato, conteudo, trecho] of casos) {
        const uploadId = await enviadoComConteudo(produtoId, formato, conteudo);
        const erro = await erroApi(confirmar(produtoId, uploadId));
        expect(erro.getStatus()).toBe(400);
        expect(erro.errors[0]!.field).toBe("arquivo");
        expect(erro.errors[0]!.message).toContain(trecho);
        await semEfeito(produtoId, uploadId);
      }
    });

    it("MP4 fragmentado (bateria) e MP4 com áudio AAC são confirmados", async () => {
      const produtoId = await novoProduto();
      const fragmentado = await enviadoComConteudo(produtoId, "video/mp4", fixtureDeMidia(FIXTURES_MIDIA.mp4Fragmentado));
      expect((await confirmar(produtoId, fragmentado)).midia._id).toBe(fragmentado);
      const comAudio = await enviadoComConteudo(produtoId, "video/mp4", mp4Sintetico({ trilhaExtra: { manipulador: "soun", codec: "mp4a", oti: 0x40 } }));
      expect((await confirmar(produtoId, comAudio)).midia._id).toBe(comAudio);
      expect(await idsDaGaleria(produtoId)).toEqual([fragmentado, comAudio]);
    });

    it("falha operacional do validador é 503 MEDIA_VALIDATION_UNAVAILABLE, sem efeito; a nova tentativa confirma", async () => {
      const produtoId = await novoProduto();
      const { uploadId } = await enviado(produtoId);
      const validador = moduleRef.get(ValidadorMidiaService);
      const quebrado = new ValidadorMidiaService({ script: fileURLToPath(new URL("../../test-utils/validador-midia-falso/processo-quebrado.ts", import.meta.url)) });
      const espiao = spyOn(validador, "validar").mockImplementation((contentType: string, bytes: Uint8Array) => quebrado.validar(contentType, bytes));
      try {
        const erro = await erroApi(confirmar(produtoId, uploadId));
        expect(erro.getStatus()).toBe(503);
        expect(erro.code).toBe("MEDIA_VALIDATION_UNAVAILABLE");
        await semEfeito(produtoId, uploadId);
      } finally {
        espiao.mockRestore();
      }
      expect((await confirmar(produtoId, uploadId)).midia._id).toBe(uploadId);
    });

    it("objeto substituído entre a inspeção (HEAD) e a leitura completa: 409 pelo ETag, sem efeito; nova confirmação valida a versão nova", async () => {
      const produtoId = await novoProduto();
      const { uploadId, chave } = await enviado(produtoId);
      const inspecionarOriginal = storage.inspecionarObjeto.bind(storage);
      const espiao = spyOn(storage, "inspecionarObjeto").mockImplementationOnce(async (key: string) => {
        const inspecao = await inspecionarOriginal(key);
        // Um novo PUT na mesma chave (mesmo tamanho e tipo) logo depois do HEAD.
        storage.enviar(chave, arquivoDoFormato("image/jpeg", 1024), "image/jpeg");
        return inspecao;
      });
      try {
        const erro = await erroApi(confirmar(produtoId, uploadId));
        expect(erro.getStatus()).toBe(409);
        await semEfeito(produtoId, uploadId);
      } finally {
        espiao.mockRestore();
      }
      expect((await confirmar(produtoId, uploadId)).midia._id).toBe(uploadId);
    });
  });
});
