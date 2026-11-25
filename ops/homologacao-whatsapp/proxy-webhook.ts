/**
 * Fase 22.8.9.10.7.7 — PROXY LOCAL SÓ DO WEBHOOK, para o túnel HTTPS da homologação.
 *
 * O túnel público (ex.: Cloudflare Quick Tunnel) aponta para ESTE proxy (127.0.0.1:3190), nunca para o backend: só
 * GET/POST em /api/v1/integracoes/whatsapp/webhook são encaminhados ao backend de homologação (127.0.0.1:PORT). Login,
 * clientes, envios e todo o resto da API respondem 404 para quem vem pela internet.
 *
 * O corpo é repassado BYTE A BYTE (a assinatura X-Hub-Signature-256 é calculada sobre os bytes originais), com os
 * cabeçalhos necessários; nada é registrado além de método, status e tamanho.
 *
 *   bun --no-env-file ops/homologacao-whatsapp/proxy-webhook.ts            (backend em 127.0.0.1:3100)
 */
export const CAMINHO_WEBHOOK = "/api/v1/integracoes/whatsapp/webhook";
export const PORTA_PROXY = Number(process.env["PROXY_WEBHOOK_PORTA"] ?? 3190);
const DESTINO = `http://127.0.0.1:${Number(process.env["PROXY_WEBHOOK_DESTINO_PORTA"] ?? 3100)}`;
const LIMITE_CORPO = 3 * 1024 * 1024; // payload documentado da Meta: até 3 MB
const CABECALHOS_REPASSADOS = ["content-type", "x-hub-signature-256", "user-agent"];

export async function encaminhar(req: Request, destino = DESTINO, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== CAMINHO_WEBHOOK || (req.method !== "GET" && req.method !== "POST")) {
    return new Response(JSON.stringify({ statusCode: 404, message: "Não encontrado." }), { status: 404, headers: { "content-type": "application/json" } });
  }
  const tamanho = Number(req.headers.get("content-length") ?? 0);
  if (tamanho > LIMITE_CORPO) return new Response(null, { status: 413 });
  const corpo = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined;
  if (corpo && corpo.byteLength > LIMITE_CORPO) return new Response(null, { status: 413 });
  const headers = new Headers();
  for (const h of CABECALHOS_REPASSADOS) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  const resposta = await fetchImpl(`${destino}${CAMINHO_WEBHOOK}${url.search}`, { method: req.method, headers, body: corpo, redirect: "manual" });
  return new Response(await resposta.arrayBuffer(), { status: resposta.status, headers: { "content-type": resposta.headers.get("content-type") ?? "text/plain" } });
}

if (import.meta.main) {
  Bun.serve({
    hostname: "127.0.0.1",
    port: PORTA_PROXY,
    maxRequestBodySize: LIMITE_CORPO,
    async fetch(req) {
      const inicio = Date.now();
      let status = 502;
      try {
        const r = await encaminhar(req);
        status = r.status;
        return r;
      } catch {
        return new Response(null, { status: 502 });
      } finally {
        console.log(JSON.stringify({ evento: "proxy.webhook", metodo: req.method, rotaWebhook: new URL(req.url).pathname === CAMINHO_WEBHOOK, status, ms: Date.now() - inicio }));
      }
    },
  });
  console.log(`proxy do webhook em http://127.0.0.1:${PORTA_PROXY}${CAMINHO_WEBHOOK} → ${DESTINO} (resto da API: 404)`);
}
