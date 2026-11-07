// Fase 60.4.3.4.4 — sonda de disponibilidade: GET <url> a cada 50 ms, uma linha NDJSON por tentativa
// ({ t: epoch ms do início, ms: latência, status }; status 0 = erro de rede/timeout). Roda em OUTRO contêiner.
import { appendFileSync } from "node:fs";

const [url, saida] = [process.argv[2] ?? "http://api-medicao:3000/health", process.argv[3] ?? "/saida/sonda.ndjson"];
for (;;) {
  const t = Date.now();
  const inicio = performance.now();
  let status = 0;
  try {
    const resposta = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    await resposta.arrayBuffer();
    status = resposta.status;
  } catch {
    status = 0;
  }
  appendFileSync(saida, `${JSON.stringify({ t, ms: +(performance.now() - inicio).toFixed(2), status })}\n`);
  await Bun.sleep(50);
}
