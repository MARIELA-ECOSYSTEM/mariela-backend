import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Controller, Get, Injectable, Module, Post, UseGuards, type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AddressInfo } from "node:net";
import { LimitarUploadMidia, LimiteUploadMidiaGuard, LimiteUploadMidiaService } from "../modules/media/limite-upload-midia.js";
import { LIMITE_REQUISICOES_UPLOAD } from "../modules/media/media.constants.js";
import { CABECALHOS_CORS, CABECALHOS_EXPOSTOS_CORS, lerOrigensCors, METODOS_CORS, montarOpcoesCors, motivoOrigemCorsInvalida } from "./cors.config.js";

/**
 * Fase 58 — política de CORS. Os testes HTTP sobem um app Nest mínimo (sem
 * banco) com EXATAMENTE as opções que `main.ts` aplica (`montarOpcoesCors`) e
 * fazem requisições/preflights com o cabeçalho `Origin`, como o navegador
 * (webview do Tauri) faria.
 */

const BACKOFFICE_DEV = "http://localhost:8081";
const PDV_DEV = "http://localhost:8080";
const TAURI_WINDOWS = "http://tauri.localhost";
const TAURI_MAC_LINUX = "tauri://localhost";

@Controller("eco")
class EcoController {
  @Get()
  responder() {
    return { ok: true };
  }
}

@Module({ controllers: [EcoController] })
class EcoModule {}

async function subirApp(origens: string[]): Promise<{ app: INestApplication; url: string }> {
  const app = await NestFactory.create(EcoModule, { logger: false });
  app.enableCors(montarOpcoesCors(origens));
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}/eco` };
}

function preflight(url: string, origem: string, metodo = "POST", cabecalhos = "authorization,content-type,idempotency-key") {
  return fetch(url, { method: "OPTIONS", headers: { Origin: origem, "Access-Control-Request-Method": metodo, "Access-Control-Request-Headers": cabecalhos } });
}

describe("CORS (Fase 58)", () => {
  describe("validação das origens configuradas", () => {
    it("aceita as origens reais: Backoffice e PDV em desenvolvimento, Tauri empacotado (Windows e macOS/Linux) e https", () => {
      for (const origem of [BACKOFFICE_DEV, PDV_DEV, TAURI_WINDOWS, TAURI_MAC_LINUX, "https://backoffice.mariela.app"]) {
        expect(motivoOrigemCorsInvalida(origem)).toBeNull();
      }
    });

    it("recusa curinga, caminho, barra final, query, credenciais, esquema estranho e 'null'", () => {
      const invalidas = ["*", "https://*.mariela.app", `${BACKOFFICE_DEV}/`, `${BACKOFFICE_DEV}/api`, `${BACKOFFICE_DEV}?x=1`, "localhost:8081", "ftp://host", "null", "https://user:pass@host", "tauri://outro"];
      for (const origem of invalidas) expect(motivoOrigemCorsInvalida(origem)).not.toBeNull();
      expect(motivoOrigemCorsInvalida("*")).toBe("curinga (*) não é permitido");
    });

    it("lê a lista separada por vírgula ignorando espaços e itens vazios; ausente = lista vazia", () => {
      expect(lerOrigensCors(` ${BACKOFFICE_DEV} ,, ${TAURI_WINDOWS} ,`)).toEqual([BACKOFFICE_DEV, TAURI_WINDOWS]);
      expect(lerOrigensCors(undefined)).toEqual([]);
      expect(lerOrigensCors("   ")).toEqual([]);
    });

    it("opções: sem origens = CORS desligado; nunca credenciais; métodos e cabeçalhos explícitos (inclui Idempotency-Key do PDV)", () => {
      expect(montarOpcoesCors([])).toMatchObject({ origin: false, credentials: false });
      expect(montarOpcoesCors([BACKOFFICE_DEV])).toEqual({
        origin: [BACKOFFICE_DEV],
        methods: [...METODOS_CORS],
        allowedHeaders: [...CABECALHOS_CORS],
        exposedHeaders: [...CABECALHOS_EXPOSTOS_CORS],
        credentials: false,
      });
      // Fase 22.8.9.9.3 — só o Retry-After é exposto; nada de curinga.
      expect(CABECALHOS_EXPOSTOS_CORS).toEqual(["Retry-After"]);
      expect(CABECALHOS_CORS).toEqual(expect.arrayContaining(["Authorization", "Content-Type", "Idempotency-Key"]));
    });
  });

  describe("comportamento HTTP com a lista real (dev + Tauri empacotado)", () => {
    let app: INestApplication;
    let url: string;

    beforeAll(async () => {
      ({ app, url } = await subirApp([BACKOFFICE_DEV, PDV_DEV, TAURI_WINDOWS, TAURI_MAC_LINUX]));
    });

    afterAll(async () => {
      await app.close();
    });

    it("a origem de desenvolvimento do Backoffice (http://localhost:8081) é aceita: Access-Control-Allow-Origin ecoa a origem, sem credenciais", async () => {
      const resposta = await fetch(url, { headers: { Origin: BACKOFFICE_DEV } });
      expect(resposta.status).toBe(200);
      expect(resposta.headers.get("access-control-allow-origin")).toBe(BACKOFFICE_DEV);
      expect(resposta.headers.get("access-control-allow-credentials")).toBeNull();
      expect(resposta.headers.get("vary")).toContain("Origin");
    });

    it("cada uma das várias origens configuradas é aceita", async () => {
      for (const origem of [BACKOFFICE_DEV, PDV_DEV, TAURI_WINDOWS, TAURI_MAC_LINUX]) {
        const resposta = await fetch(url, { headers: { Origin: origem } });
        expect(resposta.headers.get("access-control-allow-origin")).toBe(origem);
      }
    });

    it("origem não autorizada é recusada: nenhum Access-Control-Allow-Origin (o navegador bloqueia a leitura)", async () => {
      for (const origem of ["http://localhost:9999", "https://site-malicioso.example", "http://localhost:8081.evil.example", "null"]) {
        const resposta = await fetch(url, { headers: { Origin: origem } });
        expect(resposta.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    it("preflight do Backoffice/PDV: libera os métodos da API e os cabeçalhos Authorization, Content-Type e Idempotency-Key", async () => {
      const resposta = await preflight(url, BACKOFFICE_DEV, "PATCH");
      expect(resposta.status).toBe(204);
      expect(resposta.headers.get("access-control-allow-origin")).toBe(BACKOFFICE_DEV);
      const metodos = resposta.headers.get("access-control-allow-methods") ?? "";
      for (const metodo of ["GET", "POST", "PUT", "PATCH", "DELETE"]) expect(metodos).toContain(metodo);
      const cabecalhos = (resposta.headers.get("access-control-allow-headers") ?? "").toLowerCase();
      for (const cabecalho of ["authorization", "content-type", "idempotency-key"]) expect(cabecalhos).toContain(cabecalho);
      expect(resposta.headers.get("access-control-allow-credentials")).toBeNull();
    });

    it("preflight de origem não autorizada não recebe Access-Control-Allow-Origin", async () => {
      const resposta = await preflight(url, "https://site-malicioso.example");
      expect(resposta.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("comportamento HTTP com CORS_ORIGINS vazia (padrão seguro)", () => {
    let app: INestApplication;
    let url: string;

    beforeAll(async () => {
      ({ app, url } = await subirApp(lerOrigensCors("")));
    });

    afterAll(async () => {
      await app.close();
    });

    it("nenhuma origem cruzada é aceita — nem a do Backoffice (CORS desligado, nunca aberto)", async () => {
      for (const origem of [BACKOFFICE_DEV, TAURI_WINDOWS, "https://qualquer.example"]) {
        const resposta = await fetch(url, { headers: { Origin: origem } });
        expect(resposta.headers.get("access-control-allow-origin")).toBeNull();
      }
      expect((await preflight(url, BACKOFFICE_DEV)).headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  // Fase 22.8.9.9.3 — o 429 do limite de upload de mídia leva `Retry-After`, e o CORS deixa o app desktop LER esse
  // cabeçalho. Usa o guard REAL (`LimiteUploadMidiaGuard`, mesma contagem de produção); a identidade ADMIN, que em
  // produção vem do JWT, é posta por um guard de teste. Sem banco.
  describe("Retry-After do limite de upload de mídia (Fase 22.8.9.9.3)", () => {
    @Injectable()
    class IdentidadeDeTeste implements CanActivate {
      canActivate(contexto: ExecutionContext): boolean {
        contexto.switchToHttp().getRequest<{ user?: { sub: string } }>().user = { sub: "admin-teste-cors" };
        return true;
      }
    }

    @Controller("upload-limitado")
    @UseGuards(IdentidadeDeTeste)
    class UploadLimitadoController {
      @Post()
      @LimitarUploadMidia("solicitacao")
      solicitar() {
        return { ok: true };
      }
    }

    @Module({ controllers: [UploadLimitadoController], providers: [LimiteUploadMidiaService, LimiteUploadMidiaGuard, IdentidadeDeTeste] })
    class UploadLimitadoModule {}

    let app: INestApplication;
    let url: string;
    const ORIGENS = [BACKOFFICE_DEV, PDV_DEV, TAURI_WINDOWS, TAURI_MAC_LINUX];

    beforeAll(async () => {
      app = await NestFactory.create(UploadLimitadoModule, { logger: false });
      app.enableCors(montarOpcoesCors(ORIGENS));
      await app.listen(0, "127.0.0.1");
      const { port } = app.getHttpServer().address() as AddressInfo;
      url = `http://127.0.0.1:${port}/upload-limitado`;
    });

    afterAll(async () => {
      await app.close();
    });

    const postar = (origem: string) => fetch(url, { method: "POST", headers: { Origin: origem } });

    it("16 e 17. o 429 traz Retry-After e Access-Control-Expose-Headers com Retry-After para a origem do Tauri", async () => {
      const { limite, janelaMs } = LIMITE_REQUISICOES_UPLOAD.solicitacao;
      for (let i = 0; i < limite; i += 1) {
        const ok = await postar(TAURI_WINDOWS);
        expect(ok.status).toBe(201);
        // Respostas normais também expõem o cabeçalho (o navegador decide pela resposta que recebeu).
        expect(ok.headers.get("access-control-expose-headers")).toBe("Retry-After");
      }
      const recusada = await postar(TAURI_WINDOWS);
      expect(recusada.status).toBe(429);
      const segundos = Number(recusada.headers.get("retry-after"));
      expect(Number.isInteger(segundos)).toBe(true);
      expect(segundos).toBeGreaterThanOrEqual(1);
      expect(segundos).toBeLessThanOrEqual(Math.ceil(janelaMs / 1000));
      expect(recusada.headers.get("access-control-allow-origin")).toBe(TAURI_WINDOWS);
      expect(recusada.headers.get("access-control-expose-headers")).toBe("Retry-After");
      expect(recusada.headers.get("access-control-allow-credentials")).toBeNull();
    });

    it("18 e 19. origens preservadas: cada origem configurada recebe o cabeçalho exposto; origem não autorizada não recebe nada; nada de curinga", async () => {
      for (const origem of ORIGENS) {
        const r = await postar(origem);
        expect(r.headers.get("access-control-allow-origin")).toBe(origem);
        expect(r.headers.get("access-control-expose-headers")).toBe("Retry-After");
      }
      for (const origem of ["http://localhost:9999", "https://site-malicioso.example", "null"]) {
        const r = await postar(origem);
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
      }
      const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: TAURI_WINDOWS, "Access-Control-Request-Method": "POST" } });
      expect(preflight.headers.get("access-control-allow-origin")).toBe(TAURI_WINDOWS);
      for (const valor of [
        preflight.headers.get("access-control-allow-origin"),
        preflight.headers.get("access-control-allow-headers"),
        preflight.headers.get("access-control-allow-methods"),
      ]) {
        expect(valor ?? "").not.toContain("*");
      }
      expect(montarOpcoesCors(ORIGENS).origin).toEqual(ORIGENS);
    });
  });
});
