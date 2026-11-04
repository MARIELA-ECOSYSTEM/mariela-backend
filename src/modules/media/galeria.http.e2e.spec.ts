import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type { AddressInfo } from "node:net";
import { Types, type Connection } from "mongoose";
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
import { MEDIA_STORAGE } from "./media.constants.js";

const BASE_PUBLICA = "https://midia.exemplo.com";
const SECRET_FICTICIO = "segredo-ficticio-que-nunca-pode-aparecer-em-resposta";
const VARIAVEIS_R2: Record<string, string> = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "AKIAFICTICIOACCESSKEY",
  R2_SECRET_ACCESS_KEY: SECRET_FICTICIO,
  R2_BUCKET_NAME: "mariela-midia",
  R2_PUBLIC_BASE_URL: BASE_PUBLICA,
};

interface Resposta {
  status: number;
  json: Record<string, unknown>;
}
interface MidiaJson {
  id: string;
  tipo: string;
  url: string;
  ordem: number;
  varianteId: string | null;
  origem: string;
  [campo: string]: unknown;
}
interface GaleriaJson {
  midias: MidiaJson[];
  midiaPrincipalId: string | null;
}

/** `data` de uma resposta de sucesso, com o tipo esperado pelo teste. */
function dados<T>(resposta: Resposta): T {
  return resposta.json["data"] as T;
}

/**
 * Fase 60.1 — aplicação HTTP DE VERDADE (mesmos guards, pipes, filtro e interceptor) com o storage substituído
 * pelo falso (`overrideProvider(MEDIA_STORAGE)`): nenhum teste fala com o R2.
 */
describe("HTTP — Galeria de mídia do produto (integração — servidor real, storage falso)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminToken: string;
  let tokenPdv: string;
  let produtosService: ProdutosService;
  const storage = new MediaStorageFalso();
  const originais: Record<string, string | undefined> = {};
  let contador = 0;

  async function chamar(metodo: string, caminho: string, token: string | undefined, corpo?: unknown): Promise<Resposta> {
    const resposta = await fetch(`${baseUrl}/api/v1${caminho}`, {
      method: metodo,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    return { status: resposta.status, json: (await resposta.json()) as Record<string, unknown> };
  }

  async function novoProduto(): Promise<string> {
    contador += 1;
    return (await produtosService.criar({ nome: `Produto Galeria HTTP ${contador}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false }, null)).id;
  }
  const corpoUpload = (extra: Record<string, unknown> = {}) => ({ fileName: "foto.jpg", contentType: "image/jpeg", kind: "image", size: 1024, ...extra });

  /** Solicita pelo HTTP, simula o PUT no storage e confirma pelo HTTP. */
  async function midiaConfirmada(produtoId: string, corpoConfirmacao: Record<string, unknown> = {}, formato = "image/jpeg"): Promise<string> {
    const video = formato === "video/mp4";
    const solicitado = await chamar("POST", `/produtos/${produtoId}/midias/uploads`, adminToken, corpoUpload(video ? { fileName: "v.mp4", contentType: formato, kind: "video" } : {}));
    const { uploadId } = dados<{ uploadId: string }>(solicitado);
    storage.enviar(storage.ultimaChave(), arquivoDoFormato(formato, 1024), formato);
    const confirmado = await chamar("POST", `/produtos/${produtoId}/midias/uploads/${uploadId}/confirmacao`, adminToken, corpoConfirmacao);
    expect(confirmado.status).toBe(201);
    return uploadId;
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

    const authService = app.get(AuthService);
    const email = `teste.http.galeria.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Galeria", email, senha: "senha-forte-123" });
    adminToken = (await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null })).accessToken;
    await garantirItemConfiguracao(app.get(ConfiguracoesService), "categorias", "Vestidos");
    await garantirItemConfiguracao(app.get(ConfiguracoesService), "cores", "Azul");

    const vendedor = await app.get(VendedoresService).criar({ nome: "Vendedora Galeria", telefone: `1193${String(Date.now()).slice(-6)}`, ativo: true, senha: "senha123" }, null);
    const login = await chamar("POST", "/pdv/auth/login", undefined, { codigo: vendedor.codigo, senha: "senha123" });
    tokenPdv = dados<{ accessToken: string }>(login).accessToken;
  });

  beforeEach(() => storage.reiniciar());

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

  describe("autenticação e autorização (todas as rotas exigem ADMIN do Backoffice)", () => {
    it("sem token, token inválido e token do PDV retornam 401 em todos os endpoints da galeria", async () => {
      const produtoId = await novoProduto();
      const uploadId = "00000000-0000-0000-0000-000000000000";
      const rotas: [string, string, unknown][] = [
        ["POST", `/produtos/${produtoId}/midias/uploads`, corpoUpload()],
        ["POST", `/produtos/${produtoId}/midias/uploads/${uploadId}/confirmacao`, {}],
        ["GET", `/produtos/${produtoId}/midias`, undefined],
        ["PATCH", `/produtos/${produtoId}/midias/${uploadId}`, { varianteId: null }],
        ["PUT", `/produtos/${produtoId}/midias/principal`, { midiaId: uploadId }],
        ["PUT", `/produtos/${produtoId}/midias/ordem`, { midiaIds: [] }],
        ["DELETE", `/produtos/${produtoId}/midias/${uploadId}`, undefined],
      ];
      expect(tokenPdv).toBeTruthy();
      for (const [metodo, caminho, corpo] of rotas) {
        for (const token of [undefined, "token.invalido.qualquer", tokenPdv]) {
          expect((await chamar(metodo, caminho, token, corpo)).status).toBe(401);
        }
      }
      expect(storage.assinaturas).toHaveLength(0);
      expect(await connection.collection("uploads_midia").countDocuments({ produtoId: new Types.ObjectId(produtoId) })).toBe(0);
    });
  });

  describe("POST /produtos/:id/midias/uploads", () => {
    it("200 { data: { uploadId, uploadUrl, method, headers, expiresIn } }, sem credenciais nem URL pública", async () => {
      const produtoId = await novoProduto();
      const resposta = await chamar("POST", `/produtos/${produtoId}/midias/uploads`, adminToken, corpoUpload());
      expect(resposta.status).toBe(200);
      const d = dados<Record<string, unknown>>(resposta);
      expect(Object.keys(d).sort()).toEqual(["expiresIn", "headers", "method", "uploadId", "uploadUrl"]);
      expect(d["headers"]).toEqual({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" });
      expect(d["expiresIn"]).toBe(600);
      expect(JSON.stringify(resposta.json)).not.toContain(SECRET_FICTICIO);
    });

    it("validação: campos não permitidos (produtoId, key, url) e valores inválidos retornam 400; produto inexistente 404", async () => {
      const produtoId = await novoProduto();
      const caminho = `/produtos/${produtoId}/midias/uploads`;
      for (const extra of [{ produtoId }, { key: "products/x/y.jpg" }, { url: "https://x" }, { size: "grande" }, { kind: "audio" }, { contentType: "image/svg+xml", fileName: "a.svg" }]) {
        const resposta = await chamar("POST", caminho, adminToken, corpoUpload(extra));
        expect(resposta.status).toBe(400);
        expect(resposta.json["code"]).toBe("VALIDATION_ERROR");
      }
      expect((await chamar("POST", `/produtos/${new Types.ObjectId().toHexString()}/midias/uploads`, adminToken, corpoUpload())).status).toBe(404);
      expect((await chamar("POST", `/produtos/nao-e-um-id/midias/uploads`, adminToken, corpoUpload())).status).toBe(404);
    });

    it("storage indisponível: 503 com o envelope de erro padrão e code STORAGE_UNAVAILABLE", async () => {
      const produtoId = await novoProduto();
      storage.falhas.assinar = true;
      const resposta = await chamar("POST", `/produtos/${produtoId}/midias/uploads`, adminToken, corpoUpload());
      expect(resposta.status).toBe(503);
      expect(resposta.json["code"]).toBe("STORAGE_UNAVAILABLE");
      expect(resposta.json["statusCode"]).toBe(503);
      expect(typeof resposta.json["message"]).toBe("string");
    });
  });

  describe("confirmação e gerenciamento (contrato HTTP)", () => {
    it("confirmação 201 { data: { midia, midias, midiaPrincipalId } } com `id` (nunca `_id`); repetida também 201, sem duplicar", async () => {
      const produtoId = await novoProduto();
      const solicitado = dados<{ uploadId: string }>(await chamar("POST", `/produtos/${produtoId}/midias/uploads`, adminToken, corpoUpload()));
      const chave = storage.ultimaChave();
      storage.enviar(chave, arquivoDoFormato("image/jpeg"), "image/jpeg");
      const caminho = `/produtos/${produtoId}/midias/uploads/${solicitado.uploadId}/confirmacao`;

      const primeira = await chamar("POST", caminho, adminToken, {});
      expect(primeira.status).toBe(201);
      const d = dados<GaleriaJson & { midia: MidiaJson }>(primeira);
      expect(d.midia.id).toBe(solicitado.uploadId);
      expect(d.midia).not.toHaveProperty("_id");
      expect(d.midia.url).toBe(`${BASE_PUBLICA}/${chave}`);
      expect(d.midias.map((midia) => midia.id)).toEqual([solicitado.uploadId]);
      expect(d.midiaPrincipalId).toBe(solicitado.uploadId);

      const segunda = await chamar("POST", caminho, adminToken, {});
      expect(segunda.status).toBe(201);
      expect(dados<GaleriaJson>(segunda).midias).toHaveLength(1);
    });

    it("confirmação: URL/chave no corpo são rejeitadas (400) — a associação é só por uploadId; objeto ausente 400; upload de outro produto 404", async () => {
      const produtoA = await novoProduto();
      const produtoB = await novoProduto();
      const { uploadId } = dados<{ uploadId: string }>(await chamar("POST", `/produtos/${produtoA}/midias/uploads`, adminToken, corpoUpload()));
      const caminho = `/produtos/${produtoA}/midias/uploads/${uploadId}/confirmacao`;
      expect((await chamar("POST", caminho, adminToken, { url: "https://evil.exemplo.com/x.jpg" })).status).toBe(400);
      expect((await chamar("POST", caminho, adminToken, { chave: "products/outro/x.jpg" })).status).toBe(400);
      expect((await chamar("POST", caminho, adminToken, { varianteId: "nao-e-id" })).status).toBe(400);
      expect((await chamar("POST", caminho, adminToken, {})).status).toBe(400); // ainda não enviado
      expect((await chamar("POST", `/produtos/${produtoB}/midias/uploads/${uploadId}/confirmacao`, adminToken, {})).status).toBe(404);
    });

    it("GET, PATCH (associar/desassociar), PUT principal, PUT ordem e DELETE respondem 200 { data: { midias, midiaPrincipalId } }", async () => {
      const produtoId = await novoProduto();
      const variante = await produtosService.adicionarVariante(produtoId, { cor: "Azul" }, null);
      const varianteId = String(variante._id);
      const a = await midiaConfirmada(produtoId);
      const b = await midiaConfirmada(produtoId);
      const video = await midiaConfirmada(produtoId, {}, "video/mp4");

      const consulta = await chamar("GET", `/produtos/${produtoId}/midias`, adminToken);
      expect(consulta.status).toBe(200);
      expect(dados<GaleriaJson>(consulta).midias.map((midia) => midia.id)).toEqual([a, b, video]);

      const associada = await chamar("PATCH", `/produtos/${produtoId}/midias/${b}`, adminToken, { varianteId });
      expect(associada.status).toBe(200);
      expect(dados<GaleriaJson>(associada).midias.find((midia) => midia.id === b)!.varianteId).toBe(varianteId);
      expect((await chamar("PATCH", `/produtos/${produtoId}/midias/${b}`, adminToken, { varianteId: null })).status).toBe(200);
      expect((await chamar("PATCH", `/produtos/${produtoId}/midias/${b}`, adminToken, {})).status).toBe(400);
      expect((await chamar("PATCH", `/produtos/${produtoId}/midias/${video}`, adminToken, { varianteId })).status).toBe(400);

      const principal = await chamar("PUT", `/produtos/${produtoId}/midias/principal`, adminToken, { midiaId: b });
      expect(principal.status).toBe(200);
      expect(dados<GaleriaJson>(principal).midiaPrincipalId).toBe(b);
      expect((await chamar("PUT", `/produtos/${produtoId}/midias/principal`, adminToken, { midiaId: video })).status).toBe(400);

      const ordem = await chamar("PUT", `/produtos/${produtoId}/midias/ordem`, adminToken, { midiaIds: [video, b, a] });
      expect(ordem.status).toBe(200);
      expect(dados<GaleriaJson>(ordem).midias.map((midia) => midia.id)).toEqual([video, b, a]);
      expect((await chamar("PUT", `/produtos/${produtoId}/midias/ordem`, adminToken, { midiaIds: [video, b] })).status).toBe(400);
      expect((await chamar("PUT", `/produtos/${produtoId}/midias/ordem`, adminToken, { midiaIds: "a,b" })).status).toBe(400);

      const removida = await chamar("DELETE", `/produtos/${produtoId}/midias/${b}`, adminToken);
      expect(removida.status).toBe(200);
      expect(dados<GaleriaJson>(removida)).toEqual(expect.objectContaining({ midiaPrincipalId: a }));
      expect((await chamar("DELETE", `/produtos/${produtoId}/midias/${b}`, adminToken)).status).toBe(404);
      expect(storage.exclusoes).toHaveLength(0);
    });
  });

  describe("regressão dos contratos existentes", () => {
    it("GET /produtos/:id passa a trazer midias/midiaPrincipalId sem alterar os campos legados (variantes[].foto, fotoPrincipalVarianteId)", async () => {
      const produtoId = await novoProduto();
      await produtosService.adicionarVariante(produtoId, { cor: "Azul", foto: "https://legado.exemplo.com/azul.jpg" }, null);
      const imagem = await midiaConfirmada(produtoId);
      const resposta = await chamar("GET", `/produtos/${produtoId}`, adminToken);
      expect(resposta.status).toBe(200);
      const produto = dados<{ midias: MidiaJson[]; midiaPrincipalId: string | null; fotoPrincipalVarianteId: string | null; variantes: { foto: string | null }[] }>(resposta);
      expect(produto.midias.map((midia) => midia.id)).toEqual([imagem]);
      expect(produto.midiaPrincipalId).toBeNull();
      expect(produto.variantes[0]!.foto).toBe("https://legado.exemplo.com/azul.jpg");
      expect(produto.fotoPrincipalVarianteId).toBeNull();
    });

    it("POST /media/presigned-upload (Fase 40) mantém o contrato — mesmo storage (useExisting), sem Cache-Control", async () => {
      const produtoId = await novoProduto();
      const resposta = await chamar("POST", "/media/presigned-upload", adminToken, { ...corpoUpload(), produtoId });
      expect(resposta.status).toBe(200);
      const d = dados<{ headers: Record<string, string>; publicUrl: string; key: string }>(resposta);
      expect(d.headers).toEqual({ "Content-Type": "image/jpeg" });
      expect(d.publicUrl).toBe(`${BASE_PUBLICA}/${d.key}`);
      expect(storage.assinaturas[0]!.cacheControl).toBeUndefined();
    });

    it("DELETE /produtos/:id (soft delete, agora com retentativa) continua 204/200 e a galeria fica inacessível (404)", async () => {
      const produtoId = await novoProduto();
      await midiaConfirmada(produtoId);
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produtoId}`, { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } });
      expect(resposta.status).toBeLessThan(300);
      expect((await chamar("GET", `/produtos/${produtoId}/midias`, adminToken)).status).toBe(404);
    });
  });
});
