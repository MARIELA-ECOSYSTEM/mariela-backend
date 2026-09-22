import { describe, expect, it } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import type { Configuration } from "../../../config/configuration.js";
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

async function assinar(extra: Partial<{ key: string; contentType: string; contentLength: number; expiresInSeconds: number }> = {}): Promise<URL> {
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
});
