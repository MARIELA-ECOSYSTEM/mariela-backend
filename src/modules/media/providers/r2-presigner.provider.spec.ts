import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import type { ConfigService } from "@nestjs/config";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import type { Configuration } from "../../../config/configuration.js";
import { CACHE_CONTROL_MIDIA } from "../media.constants.js";
import { R2PresignerProvider } from "./r2-presigner.provider.js";

// Credenciais FICTÍCIAS: a assinatura é calculada localmente, nenhuma chamada de rede é feita (nem conta Cloudflare).
const ACCESS_KEY = "AKIAFICTICIOACCESSKEY";
const SECRET = "segredo-ficticio-que-nunca-pode-aparecer-na-url";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KEY = "products/64b0f0f0f0f0f0f0f0f0f0f0/11111111-2222-3333-4444-555555555555.jpg";

function provider(): R2PresignerProvider {
  const config = { r2: { accountId: ACCOUNT, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET, bucketName: "mariela-midia", publicBaseUrl: "https://midia.exemplo.com" } };
  return new R2PresignerProvider({ get: () => config } as unknown as ConfigService<Configuration>);
}

async function assinar(extra: Partial<{ key: string; contentType: string; contentLength: number; expiresInSeconds: number; cacheControl: string }> = {}): Promise<URL> {
  return new URL(await provider().assinarUpload({ key: KEY, contentType: "image/jpeg", contentLength: 12345, expiresInSeconds: 600, ...extra }));
}

describe("R2PresignerProvider (SDK real, credenciais fictícias, sem rede)", () => {
  it("gera uma URL do endpoint R2 do bucket configurado, apontando para a chave informada", async () => {
    const url = await assinar();
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe(`mariela-midia.${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/${KEY}`);
  });

  it("expira no prazo informado (10 minutos)", async () => {
    expect((await assinar()).searchParams.get("X-Amz-Expires")).toBe("600");
    expect((await assinar({ expiresInSeconds: 60 })).searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("assina content-type E content-length (senão o cliente poderia enviar outro tipo/tamanho)", async () => {
    const assinados = (await assinar()).searchParams.get("X-Amz-SignedHeaders")!.split(";");
    expect(assinados).toContain("content-type");
    expect(assinados).toContain("content-length");
    expect(assinados).toContain("host");
  });

  it("a assinatura muda quando o tipo, o tamanho ou a chave mudam (ficam amarrados à URL)", async () => {
    const base = (await assinar()).searchParams.get("X-Amz-Signature");
    expect((await assinar({ contentType: "image/png" })).searchParams.get("X-Amz-Signature")).not.toBe(base);
    expect((await assinar({ contentLength: 12346 })).searchParams.get("X-Amz-Signature")).not.toBe(base);
    expect((await assinar({ key: KEY.replace("111", "222") })).searchParams.get("X-Amz-Signature")).not.toBe(base);
  });

  it("identifica a Access Key (parte pública da assinatura) mas NUNCA o Secret", async () => {
    const url = await assinar();
    expect(url.searchParams.get("X-Amz-Credential")).toContain(ACCESS_KEY);
    expect(url.toString()).not.toContain(SECRET);
  });

  it("não inclui os checksums extras do SDK recente, que o R2 não aceita", async () => {
    const chaves = [...(await assinar()).searchParams.keys()].map((k) => k.toLowerCase());
    expect(chaves.some((k) => k.includes("checksum-algorithm") || k.includes("x-amz-checksum-"))).toBe(false);
  });

  it("Fase 60.1 — com cacheControl, cache-control também entra na assinatura; sem ele, o upload antigo segue igual", async () => {
    const comCache = await assinar({ cacheControl: CACHE_CONTROL_MIDIA });
    const assinados = comCache.searchParams.get("X-Amz-SignedHeaders")!.split(";");
    expect(assinados).toEqual(expect.arrayContaining(["cache-control", "content-length", "content-type", "host"]));
    expect(comCache.searchParams.get("X-Amz-Expires")).toBe("600");
    expect((await assinar()).searchParams.get("X-Amz-SignedHeaders")!.split(";")).not.toContain("cache-control");
    // O valor do Cache-Control fica amarrado à assinatura.
    expect((await assinar({ cacheControl: "no-cache" })).searchParams.get("X-Amz-Signature")).not.toBe(comCache.searchParams.get("X-Amz-Signature"));
  });
});

/**
 * Fase 60.1 — operações que falam com o R2 (`HeadObject`, `GetObject` com Range, `DeleteObject`). O `send` do SDK
 * é substituído por um espião: nenhuma chamada de rede acontece. O espião registra o comando recebido, então os
 * parâmetros reais montados pelo provider (bucket, chave, Range) são conferidos.
 */
describe("R2PresignerProvider — inspeção, leitura por Range e exclusão (send simulado, sem rede)", () => {
  const recebidos: unknown[] = [];
  let resposta: () => Promise<unknown> = async () => ({});
  let espiao: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    recebidos.length = 0;
    resposta = async () => ({});
    espiao = spyOn(S3Client.prototype, "send").mockImplementation(async (comando: unknown) => {
      recebidos.push(comando);
      return resposta();
    });
  });
  afterEach(() => espiao?.mockRestore());

  const erroSdk = (nome: string, status: number) => new S3ServiceException({ name: nome, $fault: status >= 500 ? "server" : "client", $metadata: { httpStatusCode: status } });

  it("HeadObject: devolve tamanho e Content-Type; 404 é 'não existe' (não é erro)", async () => {
    resposta = async () => ({ ContentLength: 1234, ContentType: "image/jpeg" });
    expect(await provider().inspecionarObjeto(KEY)).toEqual({ existe: true, tamanho: 1234, contentType: "image/jpeg" });
    const comando = recebidos[0];
    expect(comando).toBeInstanceOf(HeadObjectCommand);
    expect((comando as HeadObjectCommand).input).toEqual({ Bucket: "mariela-midia", Key: KEY });

    resposta = async () => {
      throw erroSdk("NotFound", 404);
    };
    expect(await provider().inspecionarObjeto(KEY)).toEqual({ existe: false });
  });

  it("GetObject: pede o Range dos primeiros bytes; 404 → null; 416 (objeto vazio) → sem bytes", async () => {
    resposta = async () => ({ Body: { transformToByteArray: async () => new Uint8Array([0xff, 0xd8, 0xff]) } });
    expect(await provider().lerPrimeirosBytes(KEY, 16)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect((recebidos[0] as GetObjectCommand).input).toEqual({ Bucket: "mariela-midia", Key: KEY, Range: "bytes=0-15" });

    resposta = async () => {
      throw erroSdk("NoSuchKey", 404);
    };
    expect(await provider().lerPrimeirosBytes(KEY, 16)).toBeNull();
    resposta = async () => {
      throw erroSdk("InvalidRange", 416);
    };
    expect(await provider().lerPrimeirosBytes(KEY, 16)).toEqual(new Uint8Array(0));
  });

  it("Fase 60.4.3.4.1 — HeadObject devolve o ETag quando o R2 informa", async () => {
    resposta = async () => ({ ContentLength: 10, ContentType: "image/png", ETag: '"abc"' });
    expect(await provider().inspecionarObjeto(KEY)).toEqual({ existe: true, tamanho: 10, contentType: "image/png", etag: '"abc"' });
  });

  it("Fase 60.4.3.4.1 — lerObjeto: GetObject SEM Range e com IfMatch; 404 → ausente; 412 → alterado; acima do máximo → alterado", async () => {
    resposta = async () => ({ ContentLength: 3, Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    expect(await provider().lerObjeto(KEY, { tamanhoMaximo: 3, ifMatch: '"abc"' })).toEqual({ estado: "lido", bytes: new Uint8Array([1, 2, 3]) });
    expect((recebidos[0] as GetObjectCommand).input).toEqual({ Bucket: "mariela-midia", Key: KEY, IfMatch: '"abc"' });

    resposta = async () => ({ ContentLength: 3, Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } });
    expect(await provider().lerObjeto(KEY, { tamanhoMaximo: 2 })).toEqual({ estado: "alterado" });
    expect((recebidos[1] as GetObjectCommand).input).toEqual({ Bucket: "mariela-midia", Key: KEY });

    resposta = async () => {
      throw erroSdk("NoSuchKey", 404);
    };
    expect(await provider().lerObjeto(KEY, { tamanhoMaximo: 3 })).toEqual({ estado: "ausente" });
    resposta = async () => {
      throw erroSdk("PreconditionFailed", 412);
    };
    expect(await provider().lerObjeto(KEY, { tamanhoMaximo: 3, ifMatch: '"velho"' })).toEqual({ estado: "alterado" });
    resposta = async () => {
      throw erroSdk("AccessDenied", 403);
    };
    let falha: unknown = null;
    try {
      await provider().lerObjeto(KEY, { tamanhoMaximo: 3 });
    } catch (erro) {
      falha = erro;
    }
    expect(falha).toBeInstanceOf(ApiException);
    expect(falha).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });

  it("DeleteObject existe como capacidade (para a limpeza futura) e monta o comando certo", async () => {
    await provider().excluirObjeto(KEY);
    expect((recebidos[0] as DeleteObjectCommand).input).toEqual({ Bucket: "mariela-midia", Key: KEY });
  });

  it("qualquer outra falha (403, 500, rede) vira 503 STORAGE_UNAVAILABLE, sem vazar o segredo", async () => {
    const falhas: (() => unknown)[] = [() => erroSdk("AccessDenied", 403), () => erroSdk("InternalError", 500), () => new Error("getaddrinfo ENOTFOUND")];
    for (const falha of falhas) {
      resposta = async () => {
        throw falha();
      };
      for (const operacao of [() => provider().inspecionarObjeto(KEY), () => provider().lerPrimeirosBytes(KEY, 16), () => provider().excluirObjeto(KEY)]) {
        try {
          await operacao();
          throw new Error("deveria ter falhado");
        } catch (erro) {
          expect(erro).toBeInstanceOf(ApiException);
          expect((erro as ApiException).getStatus()).toBe(503);
          expect((erro as ApiException).code).toBe("STORAGE_UNAVAILABLE");
          expect(JSON.stringify((erro as ApiException).getResponse())).not.toContain(SECRET);
        }
      }
    }
  });
});
