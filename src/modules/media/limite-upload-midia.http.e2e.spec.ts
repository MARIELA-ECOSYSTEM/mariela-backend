import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type { AddressInfo } from "node:net";
import type { Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { garantirItemConfiguracao } from "../../test-utils/configuracoes-teste.util.js";
import { arquivoDoFormato, MediaStorageFalso } from "../../test-utils/media-storage-falso.util.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "../auth/auth.service.js";
import { ConfiguracoesService } from "../configuracoes/configuracoes.service.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import type { Sequencia } from "../sequencias/schemas/sequencia.schema.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { LimiteUploadMidiaService } from "./limite-upload-midia.js";
import { LIMITE_REQUISICOES_UPLOAD, MEDIA_STORAGE } from "./media.constants.js";

/**
 * Fase 22.8.9.9 — limite de requisições das operações de upload, pela aplicação HTTP REAL (guards globais, JWT,
 * filtro de erros), com o storage FALSO (nenhum contato com o R2) e MongoDB descartável de teste. Arquivo próprio:
 * a aplicação (e o piso global por IP, em memória) é só deste arquivo.
 */
const VARIAVEIS_R2: Record<string, string> = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "AKIAFICTICIOACCESSKEY",
  R2_SECRET_ACCESS_KEY: "segredo-ficticio-limite-upload",
  R2_BUCKET_NAME: "mariela-midia",
  R2_PUBLIC_BASE_URL: "https://midia.exemplo.com",
};
const { limite: LIMITE, janelaMs: JANELA } = LIMITE_REQUISICOES_UPLOAD.solicitacao;

interface Resposta {
  status: number;
  json: Record<string, unknown>;
  retryAfter: string | null;
}

describe("HTTP — limite de requisições de upload de mídia por ADMIN (Fase 22.8.9.9)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminA: string;
  let adminB: string;
  let tokenPdv: string;
  let produtosService: ProdutosService;
  let limites: LimiteUploadMidiaService;
  const storage = new MediaStorageFalso();
  const originais: Record<string, string | undefined> = {};
  let contador = 0;

  async function chamar(metodo: string, caminho: string, token: string | undefined, corpo?: unknown): Promise<Resposta> {
    const resposta = await fetch(`${baseUrl}/api/v1${caminho}`, {
      method: metodo,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    return { status: resposta.status, json: (await resposta.json()) as Record<string, unknown>, retryAfter: resposta.headers.get("retry-after") };
  }

  async function novoProduto(): Promise<string> {
    contador += 1;
    return (await produtosService.criar({ nome: `Produto Limite Upload ${contador}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false }, null)).id;
  }

  /** Endpoint legado: assina uma URL sem criar registro nem mexer na galeria — ideal para contar só requisições. */
  const presigned = (token: string, produtoId: string) =>
    chamar("POST", "/media/presigned-upload", token, { fileName: "foto.jpg", contentType: "image/jpeg", kind: "image", size: 1024, produtoId });
  const solicitarGaleria = (token: string, produtoId: string) =>
    chamar("POST", `/produtos/${produtoId}/midias/uploads`, token, { fileName: "foto.jpg", contentType: "image/jpeg", kind: "image", size: 1024 });

  async function esgotarSolicitacoes(token: string, produtoId: string): Promise<void> {
    for (let i = 0; i < LIMITE; i += 1) expect((await presigned(token, produtoId)).status).toBe(200);
  }

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    for (const [nome, valor] of Object.entries(VARIAVEIS_R2)) {
      originais[nome] = process.env[nome];
      process.env[nome] = valor;
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MEDIA_STORAGE).useValue(storage).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    connection = app.get(getConnectionToken());
    produtosService = app.get(ProdutosService);
    limites = app.get(LimiteUploadMidiaService);

    const authService = app.get(AuthService);
    const sufixo = Date.now();
    for (const [indice, nome] of ["A", "B"].entries()) {
      const email = `teste.limite.upload.${nome.toLowerCase()}.${sufixo}@mariela.dev`;
      await authService.criarAdminSeed({ nome: `Admin Limite ${nome}`, email, senha: "senha-forte-123" });
      const token = (await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null })).accessToken;
      if (indice === 0) adminA = token;
      else adminB = token;
    }
    await garantirItemConfiguracao(app.get(ConfiguracoesService), "categorias", "Vestidos");
    const vendedor = await app.get(VendedoresService).criar({ nome: "Vendedora Limite", telefone: `1192${String(sufixo).slice(-6)}`, ativo: true, senha: "senha123" }, null);
    tokenPdv = ((await chamar("POST", "/pdv/auth/login", undefined, { codigo: vendedor.codigo, senha: "senha123" })).json["data"] as { accessToken: string }).accessToken;
  });

  beforeEach(() => {
    storage.reiniciar();
    limites.reiniciar();
    limites.agora = () => Date.now();
  });

  afterAll(async () => {
    await connection.collection("produtos").deleteMany({});
    await connection.collection("eventos_produto").deleteMany({});
    await connection.collection("uploads_midia").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection<Sequencia>("sequencias").deleteMany({ _id: { $in: ["produto", "vendedor", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
    for (const [nome, valor] of Object.entries(originais)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  });

  it("15/16. dentro do limite tudo passa; o excesso é 429 no envelope padrão, com Retry-After, sem detalhes internos; a cota é compartilhada pela galeria e pelo endpoint legado", async () => {
    const produtoId = await novoProduto();
    await esgotarSolicitacoes(adminA, produtoId);
    for (const resposta of [await solicitarGaleria(adminA, produtoId), await presigned(adminA, produtoId)]) {
      expect(resposta.status).toBe(429);
      expect(resposta.json).toEqual({
        statusCode: 429,
        code: "TOO_MANY_REQUESTS",
        message: "Muitas solicitações de envio de mídia em pouco tempo. Aguarde um instante e tente novamente.",
        errors: [],
      });
      expect(Number(resposta.retryAfter)).toBeGreaterThan(0);
      expect(Number(resposta.retryAfter)).toBeLessThanOrEqual(JANELA / 1000);
    }
    // A recusa aconteceu antes do serviço: nenhuma URL assinada e nenhum registro a mais.
    expect(storage.assinaturas).toHaveLength(LIMITE);
    expect(await connection.collection("uploads_midia").countDocuments({})).toBe(0);
  });

  it("17. a cota é do ADMIN autenticado: o ADMIN B continua liberado; o token do PDV continua 401 (antes do limite)", async () => {
    const produtoId = await novoProduto();
    await esgotarSolicitacoes(adminA, produtoId);
    expect((await presigned(adminA, produtoId)).status).toBe(429);
    expect((await presigned(adminB, produtoId)).status).toBe(200);
    expect((await solicitarGaleria(adminB, produtoId)).status).toBe(200);
    expect((await presigned(tokenPdv, produtoId)).status).toBe(401);
    expect((await solicitarGaleria(undefined as unknown as string, produtoId)).status).toBe(401);
  });

  it("18. requisições CONCORRENTES não contornam o limite: de limite+10 simultâneas, exatamente `limite` passam", async () => {
    const produtoId = await novoProduto();
    const respostas = await Promise.all(Array.from({ length: LIMITE + 10 }, () => presigned(adminA, produtoId)));
    expect(respostas.filter((r) => r.status === 200)).toHaveLength(LIMITE);
    expect(respostas.filter((r) => r.status === 429)).toHaveLength(10);
    expect(storage.assinaturas).toHaveLength(LIMITE);
  });

  it("19. passada a janela, novas tentativas são permitidas", async () => {
    const produtoId = await novoProduto();
    await esgotarSolicitacoes(adminA, produtoId);
    expect((await presigned(adminA, produtoId)).status).toBe(429);
    const base = Date.now();
    limites.agora = () => base + JANELA + 1;
    expect((await presigned(adminA, produtoId)).status).toBe(200);
  });

  it("20. com a cota de solicitação esgotada, leitura e edição da galeria continuam funcionando, e a confirmação tem cota própria", async () => {
    const produtoId = await novoProduto();
    const pedidos = [await solicitarGaleria(adminA, produtoId), await solicitarGaleria(adminA, produtoId)];
    const [primeiro, segundo] = pedidos.map((r) => (r.json["data"] as { uploadId: string }).uploadId);
    for (const id of [primeiro, segundo]) storage.enviar(`products/${produtoId}/${id}.jpg`, arquivoDoFormato("image/jpeg", 1024), "image/jpeg");
    expect((await chamar("POST", `/produtos/${produtoId}/midias/uploads/${primeiro}/confirmacao`, adminA, {})).status).toBe(201);

    for (let i = 0; i < LIMITE - 2; i += 1) expect((await presigned(adminA, produtoId)).status).toBe(200);
    expect((await solicitarGaleria(adminA, produtoId)).status).toBe(429);

    expect((await chamar("POST", `/produtos/${produtoId}/midias/uploads/${segundo}/confirmacao`, adminA, {})).status).toBe(201);
    expect((await chamar("GET", `/produtos/${produtoId}/midias`, adminA)).status).toBe(200);
    expect((await chamar("PUT", `/produtos/${produtoId}/midias/principal`, adminA, { midiaId: segundo })).status).toBe(200);
    expect((await chamar("PUT", `/produtos/${produtoId}/midias/ordem`, adminA, { midiaIds: [segundo, primeiro] })).status).toBe(200);
    expect((await chamar("PATCH", `/produtos/${produtoId}/midias/${primeiro}`, adminA, { varianteId: null })).status).toBe(200);
    expect((await chamar("DELETE", `/produtos/${produtoId}/midias/${primeiro}`, adminA)).status).toBe(200);
    for (let i = 0; i < 20; i += 1) expect((await chamar("GET", `/produtos/${produtoId}/midias`, adminA)).status).toBe(200);
  });
});
