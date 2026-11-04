import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AddressInfo } from "node:net";
import { CABECALHOS_CORS, lerOrigensCors, METODOS_CORS, montarOpcoesCors, motivoOrigemCorsInvalida } from "./cors.config.js";

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
        credentials: false,
      });
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
});
