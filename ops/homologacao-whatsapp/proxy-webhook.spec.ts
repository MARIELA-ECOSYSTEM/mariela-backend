import { describe, expect, it } from "bun:test";
import { CAMINHO_WEBHOOK, encaminhar } from "./proxy-webhook.js";

/** Fase 22.8.9.10.7.7 — proxy só do webhook: nada de rede (fetch falso). */
function fetchFalso() {
  const chamadas: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    chamadas.push({ url, init });
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  }) as unknown as typeof fetch;
  return { impl, chamadas };
}
const BASE = "http://127.0.0.1:3190";

describe("proxy do webhook (homologação)", () => {
  it("encaminha só GET/POST do caminho do webhook, com query e corpo BYTE A BYTE e só os cabeçalhos necessários", async () => {
    const f = fetchFalso();
    const bytes = new TextEncoder().encode('{"a": "Jo\\u00e3o",  "b":1}');
    const r = await encaminhar(
      new Request(`${BASE}${CAMINHO_WEBHOOK}?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=abc", authorization: "Bearer NAO-REPASSAR", cookie: "c=1" },
        body: bytes,
      }),
      "http://127.0.0.1:3100",
      f.impl,
    );
    expect(r.status).toBe(200);
    expect(f.chamadas).toHaveLength(1);
    expect(f.chamadas[0]!.url).toBe(`http://127.0.0.1:3100${CAMINHO_WEBHOOK}?x=1`);
    expect(Array.from(f.chamadas[0]!.init.body as Uint8Array)).toEqual(Array.from(bytes));
    const h = f.chamadas[0]!.init.headers as Headers;
    expect(h.get("x-hub-signature-256")).toBe("sha256=abc");
    expect(h.get("authorization")).toBeNull();
    expect(h.get("cookie")).toBeNull();

    await encaminhar(new Request(`${BASE}${CAMINHO_WEBHOOK}?hub.mode=subscribe&hub.challenge=1`), "http://127.0.0.1:3100", f.impl);
    expect(f.chamadas[1]!.init.method).toBe("GET");
  });

  it("qualquer outra rota ou método → 404, sem tocar no backend", async () => {
    const f = fetchFalso();
    for (const [metodo, caminho] of [
      ["POST", "/api/v1/auth/login"],
      ["GET", "/api/v1/clientes"],
      ["POST", "/api/v1/integracoes/whatsapp/envios/texto"],
      ["GET", "/health"],
      ["GET", `${CAMINHO_WEBHOOK}/../../auth/login`],
      ["DELETE", CAMINHO_WEBHOOK],
      ["PUT", CAMINHO_WEBHOOK],
    ] as const) {
      expect((await encaminhar(new Request(`${BASE}${caminho}`, { method: metodo }), "http://127.0.0.1:3100", f.impl)).status).toBe(404);
    }
    expect(f.chamadas).toHaveLength(0);
  });
});
