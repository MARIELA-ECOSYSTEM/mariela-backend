import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getConnectionToken } from "@nestjs/mongoose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { Types, type Connection } from "mongoose";
import { AppModule } from "../../app.module.js";
import { HttpExceptionFilter } from "../../common/filters/http-exception.filter.js";
import { ResponseInterceptor } from "../../common/interceptors/response.interceptor.js";
import { validationExceptionFactory } from "../../common/pipes/validation-exception-factory.js";
import { MONGODB_URI_TESTE } from "../../test-utils/mongo-teste.util.js";
import { AuthService } from "../auth/auth.service.js";
import { ProdutosService } from "../produtos/produtos.service.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";

const MB = 1024 * 1024;
const BASE_PUBLICA = "https://midia.exemplo.com";
const ACCESS_KEY_FICTICIA = "AKIAFICTICIOACCESSKEY";
const SECRET_FICTICIO = "segredo-ficticio-que-nunca-pode-aparecer-em-resposta";
const VARIAVEIS_R2: Record<string, string> = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: ACCESS_KEY_FICTICIA,
  R2_SECRET_ACCESS_KEY: SECRET_FICTICIO,
  R2_BUCKET_NAME: "mariela-midia",
  R2_PUBLIC_BASE_URL: BASE_PUBLICA,
};

/**
 * Sobe a aplicação HTTP DE VERDADE (mesmos guards, pipes e filtros) com credenciais R2 FICTÍCIAS: a URL pré-assinada
 * é calculada localmente, então nenhum teste depende (nem fala com) a conta Cloudflare.
 */
describe("HTTP — Mídia / upload pré-assinado (integração — servidor real, R2 fictício)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let connection: Connection;
  let adminToken: string;
  let produtoId: string;
  const idsProdutos: string[] = [];
  const originais: Record<string, string | undefined> = {};

  function headers(token?: string): Record<string, string> {
    return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }
  function corpo(extra: Record<string, unknown> = {}) {
    return { fileName: "vestido.jpg", contentType: "image/jpeg", kind: "image", size: 2 * MB, produtoId, ...extra };
  }
  async function solicitar(token: string | undefined, body: unknown) {
    const resposta = await fetch(`${baseUrl}/api/v1/media/presigned-upload`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
    return { status: resposta.status, json: (await resposta.json()) as Record<string, any> };
  }

  beforeAll(async () => {
    process.env["MONGODB_URI"] = MONGODB_URI_TESTE;
    for (const [nome, valor] of Object.entries(VARIAVEIS_R2)) {
      originais[nome] = process.env[nome];
      process.env[nome] = valor;
    }
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, exceptionFactory: validationExceptionFactory }));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix("api/v1", { exclude: ["health", "docs"] });
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    connection = app.get(getConnectionToken());

    const authService = app.get(AuthService);
    const email = `teste.http.media.${Date.now()}@mariela.dev`;
    await authService.criarAdminSeed({ nome: "HTTP Mídia", email, senha: "senha-forte-123" });
    adminToken = (await authService.login({ usuario: email, senha: "senha-forte-123" }, { ip: null, userAgent: null })).accessToken;

    const produto = await app.get(ProdutosService).criar(
      { nome: `Produto Mídia ${Date.now()}`, categoria: "Vestidos", precoCusto: 50, precoVenda: 100, ehNovidade: false },
      null,
    );
    produtoId = produto.id;
    idsProdutos.push(produtoId);
  });

  afterAll(async () => {
    for (const id of idsProdutos) {
      await connection.collection("produtos").deleteOne({ _id: new Types.ObjectId(id) });
      await connection.collection("eventos_produto").deleteMany({ produtoId: new Types.ObjectId(id) });
    }
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("vendedor_refresh_tokens").deleteMany({});
    await connection.collection("eventos_pdv_auth").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["produto", "vendedor", "usuario"] } });
    await connection.collection("usuarios").deleteMany({});
    await connection.collection("refresh_tokens").deleteMany({});
    await connection.collection("eventos_auth").deleteMany({});
    await app.close();
    for (const [nome, valor] of Object.entries(originais)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  });

  describe("autenticação e autorização", () => {
    it("SEM token retorna 401", async () => {
      expect((await solicitar(undefined, corpo())).status).toBe(401);
    });

    it("token inválido retorna 401", async () => {
      expect((await solicitar("token.invalido.qualquer", corpo())).status).toBe(401);
    });

    it("um token do PDV (vendedor) é rejeitado (401): o endpoint é só do Backoffice", async () => {
      const vendedor = await app.get(VendedoresService).criar({ nome: "Vendedora Mídia", telefone: `1194${String(Date.now()).slice(-6)}`, ativo: true, senha: "senha123" }, null);
      const login = await fetch(`${baseUrl}/api/v1/pdv/auth/login`, { method: "POST", headers: headers(), body: JSON.stringify({ codigo: vendedor.codigo, senha: "senha123" }) });
      const tokenPdv = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
      expect(tokenPdv).toBeTruthy();
      expect((await solicitar(tokenPdv, corpo())).status).toBe(401);
    });
  });

  describe("contrato (ADMIN autenticado)", () => {
    it("200 com o envelope { data } e todos os campos; a chave fica sob products/{produtoId}/ e a URL pública usa R2_PUBLIC_BASE_URL", async () => {
      const { status, json } = await solicitar(adminToken, corpo());
      expect(status).toBe(200);
      const d = json["data"];
      expect(Object.keys(d).sort()).toEqual(["expiresIn", "headers", "key", "method", "publicUrl", "uploadUrl"]);
      expect(d.method).toBe("PUT");
      expect(d.expiresIn).toBe(600);
      expect(d.headers).toEqual({ "Content-Type": "image/jpeg" });
      expect(d.key).toMatch(new RegExp(`^products/${produtoId}/[0-9a-f-]{36}\\.jpg$`));
      expect(d.publicUrl).toBe(`${BASE_PUBLICA}/${d.key}`);
      const url = new URL(d.uploadUrl);
      expect(url.host).toBe("mariela-midia.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
      expect(url.pathname).toBe(`/${d.key}`);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    });

    it("nenhuma credencial aparece na resposta", async () => {
      const { json } = await solicitar(adminToken, corpo());
      const texto = JSON.stringify(json);
      expect(texto).not.toContain(SECRET_FICTICIO);
      expect(texto).not.toContain("R2_SECRET_ACCESS_KEY");
    });

    it("vídeo mp4 de até 15 MB é aceito e gera chave .mp4", async () => {
      const { status, json } = await solicitar(adminToken, corpo({ fileName: "vestido.mp4", contentType: "video/mp4", kind: "video", size: 15 * MB }));
      expect(status).toBe(200);
      expect(json["data"].key.endsWith(".mp4")).toBe(true);
    });

    it("cada requisição gera uma chave nova", async () => {
      const a = (await solicitar(adminToken, corpo())).json["data"].key;
      const b = (await solicitar(adminToken, corpo())).json["data"].key;
      expect(a).not.toBe(b);
    });
  });

  describe("validação (400/404)", () => {
    it("tipo não permitido retorna 400 VALIDATION_ERROR com erro em contentType", async () => {
      const { status, json } = await solicitar(adminToken, corpo({ fileName: "x.svg", contentType: "image/svg+xml" }));
      expect(status).toBe(400);
      expect(json["code"]).toBe("VALIDATION_ERROR");
      expect(json["errors"].map((e: { field: string }) => e.field)).toContain("contentType");
    });

    it("imagem acima de 5 MB e vídeo acima de 15 MB retornam 400", async () => {
      expect((await solicitar(adminToken, corpo({ size: 5 * MB + 1 }))).status).toBe(400);
      expect((await solicitar(adminToken, corpo({ fileName: "v.mp4", contentType: "video/mp4", kind: "video", size: 15 * MB + 1 }))).status).toBe(400);
    });

    it("bucket/key enviados pelo cliente são REJEITADOS (400): o backend controla o prefixo", async () => {
      expect((await solicitar(adminToken, corpo({ key: "products/outro/arquivo.jpg" }))).status).toBe(400);
      expect((await solicitar(adminToken, corpo({ bucket: "outro-bucket" }))).status).toBe(400);
    });

    it("size não numérico, kind inválido e produtoId malformado retornam 400", async () => {
      expect((await solicitar(adminToken, corpo({ size: "grande" }))).status).toBe(400);
      expect((await solicitar(adminToken, corpo({ kind: "audio" }))).status).toBe(400);
      expect((await solicitar(adminToken, corpo({ produtoId: "nao-e-um-id" }))).status).toBe(400);
    });

    it("produto inexistente retorna 404", async () => {
      expect((await solicitar(adminToken, corpo({ produtoId: new Types.ObjectId().toHexString() }))).status).toBe(404);
    });
  });

  describe("contrato de Produto/Variante preservado", () => {
    it("a publicUrl devolvida é aceita pelo endpoint de variante já existente em foto e video (nada mudou)", async () => {
      const foto = (await solicitar(adminToken, corpo())).json["data"].publicUrl;
      const video = (await solicitar(adminToken, corpo({ fileName: "v.mp4", contentType: "video/mp4", kind: "video", size: 1 * MB }))).json["data"].publicUrl;
      const resposta = await fetch(`${baseUrl}/api/v1/produtos/${produtoId}/variantes`, {
        method: "POST",
        headers: headers(adminToken),
        body: JSON.stringify({ cor: "Azul", foto, video }),
      });
      expect(resposta.status).toBe(201);
      const variante = ((await resposta.json()) as { data: { foto: string; video: string } }).data;
      expect(variante.foto).toBe(foto);
      expect(variante.video).toBe(video);
    });
  });
});
