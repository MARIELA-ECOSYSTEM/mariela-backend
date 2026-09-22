import { describe, expect, it } from "bun:test";
import type { ConfigService } from "@nestjs/config";
import { ApiException } from "../../common/exceptions/api.exception.js";
import type { Configuration } from "../../config/configuration.js";
import type { ProdutosService } from "../produtos/produtos.service.js";
import type { SolicitarUploadDto } from "./dto/solicitar-upload.dto.js";
import { MediaService } from "./media.service.js";
import type { AssinarUploadParams, MediaPresigner } from "./media.types.js";

const MB = 1024 * 1024;
const PRODUTO_ID = "64b0f0f0f0f0f0f0f0f0f0f0";
const BASE_PUBLICA = "https://midia.exemplo.com";
const ACCESS_KEY_FICTICIA = "AKIAFICTICIOACCESSKEY";
const SECRET_FICTICIO = "segredo-ficticio-que-nunca-pode-aparecer-em-resposta";

type R2 = Configuration["storage"]["r2"];
const R2_COMPLETO: R2 = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: ACCESS_KEY_FICTICIA,
  secretAccessKey: SECRET_FICTICIO,
  bucketName: "mariela-midia",
  publicBaseUrl: BASE_PUBLICA,
};

function montar(r2: Partial<R2> = {}, produtoExiste = true) {
  const chamadasPresigner: AssinarUploadParams[] = [];
  const produtosConsultados: string[] = [];
  const presigner: MediaPresigner = {
    async assinarUpload(params) {
      chamadasPresigner.push(params);
      return `https://assinada.exemplo.invalid/${params.key}?X-Amz-Signature=fake`;
    },
  };
  const configService = { get: () => ({ r2: { ...R2_COMPLETO, ...r2 } }) } as unknown as ConfigService<Configuration>;
  const produtosService = {
    async obterPorId(id: string) {
      produtosConsultados.push(id);
      if (!produtoExiste) throw ApiException.notFound("Produto não encontrado.");
      return { id };
    },
  } as unknown as ProdutosService;
  return { service: new MediaService(configService, produtosService, presigner), chamadasPresigner, produtosConsultados };
}

function dto(extra: Partial<SolicitarUploadDto> = {}): SolicitarUploadDto {
  return { fileName: "vestido.jpg", contentType: "image/jpeg", kind: "image", size: 1 * MB, produtoId: PRODUTO_ID, ...extra };
}

async function falha(promessa: Promise<unknown>): Promise<ApiException> {
  try {
    await promessa;
  } catch (erro) {
    expect(erro).toBeInstanceOf(ApiException);
    return erro as ApiException;
  }
  throw new Error("A operação deveria ter falhado.");
}

describe("MediaService.solicitarUploadPresignado", () => {
  describe("sucesso", () => {
    it("devolve o contrato completo, com expiração de 10 minutos e a URL pública montada por R2_PUBLIC_BASE_URL", async () => {
      const { service } = montar();
      const r = await service.solicitarUploadPresignado(dto());

      expect(r.method).toBe("PUT");
      expect(r.expiresIn).toBe(600);
      expect(r.headers).toEqual({ "Content-Type": "image/jpeg" });
      expect(r.key).toMatch(new RegExp(`^products/${PRODUTO_ID}/[0-9a-f-]{36}\\.jpg$`));
      expect(r.publicUrl).toBe(`${BASE_PUBLICA}/${r.key}`);
      expect(r.uploadUrl).toContain(r.key);
    });

    it("assina exatamente o tipo, o tamanho e a validade que o backend validou, e consulta o produto", async () => {
      const { service, chamadasPresigner, produtosConsultados } = montar();
      const r = await service.solicitarUploadPresignado(dto({ size: 3 * MB }));

      expect(chamadasPresigner).toHaveLength(1);
      expect(chamadasPresigner[0]).toEqual({ key: r.key, contentType: "image/jpeg", contentLength: 3 * MB, expiresInSeconds: 600 });
      expect(produtosConsultados).toEqual([PRODUTO_ID]);
    });

    it("cada MIME permitido gera a extensão canônica na chave", async () => {
      const casos: [SolicitarUploadDto["kind"], string, string, string][] = [
        ["image", "image/jpeg", "foto.jpg", "jpg"],
        ["image", "image/png", "foto.png", "png"],
        ["image", "image/webp", "foto.webp", "webp"],
        ["image", "image/gif", "foto.gif", "gif"],
        ["video", "video/mp4", "clipe.mp4", "mp4"],
      ];
      for (const [kind, contentType, fileName, extensao] of casos) {
        const { service } = montar();
        const r = await service.solicitarUploadPresignado(dto({ kind, contentType, fileName }));
        expect(r.key.endsWith(`.${extensao}`)).toBe(true);
      }
    });

    it("aceita .jpeg e extensão em maiúsculas para image/jpeg, mas a chave sempre usa .jpg", async () => {
      for (const fileName of ["foto.jpeg", "FOTO.JPG", "Foto.JpEg"]) {
        const { service } = montar();
        const r = await service.solicitarUploadPresignado(dto({ fileName }));
        expect(r.key.endsWith(".jpg")).toBe(true);
      }
    });

    it("gera chaves únicas a cada chamada, mesmo com os mesmos dados", async () => {
      const { service } = montar();
      const chaves = new Set<string>();
      for (let i = 0; i < 25; i += 1) chaves.add((await service.solicitarUploadPresignado(dto())).key);
      expect(chaves.size).toBe(25);
    });

    it("NUNCA usa o nome original na chave; o prefixo é controlado pelo backend", async () => {
      const { service } = montar();
      const r = await service.solicitarUploadPresignado(dto({ fileName: "../../etc/segredo vestido novo.jpg" }));
      expect(r.key).not.toContain("vestido");
      expect(r.key).not.toContain("..");
      expect(r.key.startsWith(`products/${PRODUTO_ID}/`)).toBe(true);
      expect(r.key.split("/")).toHaveLength(3);
    });

    it("não inclui credenciais em nenhum campo da resposta", async () => {
      const { service } = montar();
      const texto = JSON.stringify(await service.solicitarUploadPresignado(dto()));
      expect(texto).not.toContain(SECRET_FICTICIO);
      expect(texto).not.toContain(ACCESS_KEY_FICTICIA);
    });
  });

  describe("MIME e tipo de mídia", () => {
    for (const contentType of ["image/svg+xml", "image/bmp", "image/tiff", "application/pdf", "video/webm", "video/quicktime", "text/html", "application/octet-stream", ""]) {
      it(`rejeita o tipo "${contentType}" com erro no campo contentType, sem assinar nem consultar o produto`, async () => {
        const { service, chamadasPresigner, produtosConsultados } = montar();
        const erro = await falha(service.solicitarUploadPresignado(dto({ contentType })));
        expect(erro.getStatus()).toBe(400);
        expect(erro.code).toBe("VALIDATION_ERROR");
        expect(erro.errors.map((e) => e.field)).toContain("contentType");
        expect(chamadasPresigner).toHaveLength(0);
        expect(produtosConsultados).toHaveLength(0);
      });
    }

    it("rejeita MIME de vídeo declarado como image (e o inverso) com erro no campo kind", async () => {
      const { service } = montar();
      const a = await falha(service.solicitarUploadPresignado(dto({ kind: "image", contentType: "video/mp4", fileName: "x.mp4" })));
      expect(a.errors.map((e) => e.field)).toEqual(["kind"]);
      const b = await falha(service.solicitarUploadPresignado(dto({ kind: "video", contentType: "image/png", fileName: "x.png" })));
      expect(b.errors.map((e) => e.field)).toEqual(["kind"]);
    });

    it("rejeita extensão que não corresponde ao MIME declarado (inclui executáveis e nome sem extensão)", async () => {
      for (const fileName of ["foto.exe", "foto.png", "foto", "foto.", ".jpg.php", "foto.jpg.exe"]) {
        const { service } = montar();
        const erro = await falha(service.solicitarUploadPresignado(dto({ fileName })));
        expect(erro.errors.map((e) => e.field)).toEqual(["fileName"]);
      }
    });
  });

  describe("limites de tamanho", () => {
    it("imagem: aceita exatamente 5 MB e rejeita 5 MB + 1 byte", async () => {
      const { service } = montar();
      await service.solicitarUploadPresignado(dto({ size: 5 * MB }));
      const erro = await falha(service.solicitarUploadPresignado(dto({ size: 5 * MB + 1 })));
      expect(erro.errors).toEqual([{ field: "size", message: "Arquivo excede o limite de 5 MB para imagens." }]);
    });

    it("vídeo: aceita exatamente 15 MB e rejeita 15 MB + 1 byte", async () => {
      const { service } = montar();
      const video = { kind: "video" as const, contentType: "video/mp4", fileName: "clipe.mp4" };
      await service.solicitarUploadPresignado(dto({ ...video, size: 15 * MB }));
      const erro = await falha(service.solicitarUploadPresignado(dto({ ...video, size: 15 * MB + 1 })));
      expect(erro.errors).toEqual([{ field: "size", message: "Arquivo excede o limite de 15 MB para vídeos." }]);
    });

    it("os limites são por tipo: 10 MB é aceito para vídeo e recusado para imagem", async () => {
      const { service } = montar();
      await service.solicitarUploadPresignado(dto({ kind: "video", contentType: "video/mp4", fileName: "clipe.mp4", size: 10 * MB }));
      const erro = await falha(service.solicitarUploadPresignado(dto({ size: 10 * MB })));
      expect(erro.errors.map((e) => e.field)).toEqual(["size"]);
    });

    it("acumula todos os erros de validação numa única resposta 400", async () => {
      const { service } = montar();
      const erro = await falha(service.solicitarUploadPresignado(dto({ contentType: "application/pdf", size: 50 * MB })));
      expect(erro.errors.map((e) => e.field).sort()).toEqual(["contentType", "size"]);
    });
  });

  describe("configuração do R2 ausente", () => {
    it("sem nenhuma variável: 503 STORAGE_NOT_CONFIGURED listando só os NOMES, sem assinar nem consultar o produto", async () => {
      const { service, chamadasPresigner, produtosConsultados } = montar({ accountId: "", accessKeyId: "", secretAccessKey: "", bucketName: "", publicBaseUrl: "" });
      const erro = await falha(service.solicitarUploadPresignado(dto()));
      expect(erro.getStatus()).toBe(503);
      expect(erro.code).toBe("STORAGE_NOT_CONFIGURED");
      for (const nome of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL"]) {
        expect(erro.message).toContain(nome);
      }
      expect(chamadasPresigner).toHaveLength(0);
      expect(produtosConsultados).toHaveLength(0);
    });

    it("configuração parcial: cita só a variável que falta e nunca os valores das demais", async () => {
      const { service } = montar({ secretAccessKey: "" });
      const erro = await falha(service.solicitarUploadPresignado(dto()));
      expect(erro.code).toBe("STORAGE_NOT_CONFIGURED");
      expect(erro.message).toContain("R2_SECRET_ACCESS_KEY");
      expect(erro.message).not.toContain("R2_BUCKET_NAME");
      for (const valor of [ACCESS_KEY_FICTICIA, R2_COMPLETO.accountId, R2_COMPLETO.bucketName, BASE_PUBLICA]) {
        expect(erro.message).not.toContain(valor);
      }
    });

    it("sem R2_PUBLIC_BASE_URL não há como montar a URL pública: 503", async () => {
      const { service } = montar({ publicBaseUrl: "" });
      expect((await falha(service.solicitarUploadPresignado(dto()))).code).toBe("STORAGE_NOT_CONFIGURED");
    });
  });

  describe("produto", () => {
    it("produto inexistente: propaga o 404 e não assina nada", async () => {
      const { service, chamadasPresigner } = montar({}, false);
      const erro = await falha(service.solicitarUploadPresignado(dto()));
      expect(erro.getStatus()).toBe(404);
      expect(chamadasPresigner).toHaveLength(0);
    });
  });
});
