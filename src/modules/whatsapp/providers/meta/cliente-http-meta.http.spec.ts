import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { ClienteHttpMetaWhatsapp } from "./cliente-http-meta.js";
import { classificarRespostaEnvio } from "./contrato-meta.js";

/**
 * Fase 22.8.9.10.4 — o cliente HTTP isolado contra servidores TCP LOCAIS (127.0.0.1) que imitam cada falha de rede:
 * HTTP real, `fetch` real do Bun, nenhuma chamada à Meta. A URL base só é trocada aqui, nos testes.
 */
const TOKEN = "TOKEN-FICTICIO-DE-TESTE";
const servidores: Server[] = [];
const sockets = new Set<Socket>();

async function servidor(aoReceber: (s: Socket, pedido: string) => void): Promise<string> {
  const srv = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    let pedido = "";
    s.on("data", (d) => {
      pedido += d.toString();
      // Cabeçalhos + corpo completos (Content-Length) antes de reagir.
      const fim = pedido.indexOf("\r\n\r\n");
      if (fim < 0) return;
      const tamanho = Number(/content-length:\s*(\d+)/i.exec(pedido)?.[1] ?? 0);
      if (pedido.length - fim - 4 >= tamanho) aoReceber(s, pedido);
    });
  });
  servidores.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

const req = (timeoutMs = 2_000) => ({ metodo: "POST" as const, caminho: "/v26.0/1/messages", corpo: { a: 1 }, token: TOKEN, timeoutMs });

afterEach(() => {
  for (const s of sockets) s.destroy();
});

afterAll(() => {
  for (const s of servidores) s.close();
});

describe("cliente HTTP da Meta — falhas reais de rede (loopback)", () => {
  it("resposta normal: status e corpo completos; um único pedido com Bearer e JSON", async () => {
    const pedidos: string[] = [];
    const base = await servidor((s, p) => {
      pedidos.push(p);
      const corpo = '{"messaging_product":"whatsapp","messages":[{"id":"wamid.A"}]}';
      s.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${corpo.length}\r\nConnection: close\r\n\r\n${corpo}`);
    });
    const r = await new ClienteHttpMetaWhatsapp(undefined, base).requisitar(req());
    expect(r).toEqual({ tipo: "resposta", status: 200, corpo: '{"messaging_product":"whatsapp","messages":[{"id":"wamid.A"}]}' });
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]).toStartWith("POST /v26.0/1/messages HTTP/1.1");
    expect(pedidos[0]!.toLowerCase()).toContain(`authorization: bearer ${TOKEN.toLowerCase()}`);
    expect(pedidos[0]).toEndWith('{"a":1}');
  });

  it("servidor recebe o pedido e nunca responde → timeout → indeterminada (sem nova tentativa)", async () => {
    let pedidos = 0;
    const base = await servidor(() => {
      pedidos += 1;
    });
    const inicio = Date.now();
    const r = await new ClienteHttpMetaWhatsapp(undefined, base).requisitar(req(300));
    expect(r).toEqual({ tipo: "timeout" });
    expect(Date.now() - inicio).toBeLessThan(2_000);
    expect(classificarRespostaEnvio(r).resultado).toEqual({ resultado: "indeterminada", codigoProvedor: "TIMEOUT" });
    await new Promise((res) => setTimeout(res, 100));
    expect(pedidos).toBe(1);
  });

  it("cabeçalhos enviados e corpo nunca termina → timeout durante a leitura do corpo", async () => {
    const base = await servidor((s) => s.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"));
    const r = await new ClienteHttpMetaWhatsapp(undefined, base).requisitar(req(300));
    expect(r).toEqual({ tipo: "timeout" });
  });

  it("conexão cortada depois de receber o pedido → interrompida → indeterminada", async () => {
    const base = await servidor((s) => s.destroy());
    const r = await new ClienteHttpMetaWhatsapp(undefined, base).requisitar(req());
    expect(r).toEqual({ tipo: "interrompida" });
    expect(classificarRespostaEnvio(r).resultado).toEqual({ resultado: "indeterminada", codigoProvedor: "CONEXAO_INTERROMPIDA" });
  });

  it("corpo cortado no meio (resposta incompleta) → interrompida → indeterminada", async () => {
    const base = await servidor((s) => {
      s.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"messaging_product":"whats');
      setTimeout(() => s.destroy(), 30);
    });
    const r = await new ClienteHttpMetaWhatsapp(undefined, base).requisitar(req());
    expect(r).toEqual({ tipo: "interrompida" });
  });

  it("porta sem servidor (conexão recusada) → sem_conexao → recusada PROVEDOR_INDISPONIVEL", async () => {
    const base = await servidor(() => {});
    const srv = servidores.pop()!;
    await new Promise<void>((r) => srv.close(() => r()));
    const r = await new ClienteHttpMetaWhatsapp(undefined, base).requisitar(req());
    expect(r).toEqual({ tipo: "sem_conexao", motivo: "CONEXAO_RECUSADA" });
    expect(classificarRespostaEnvio(r).resultado).toEqual({ resultado: "recusada", codigo: "PROVEDOR_INDISPONIVEL", codigoProvedor: "CONEXAO_RECUSADA" });
  });

  it("redirecionamento NÃO é seguido (o token nunca vai para outro host) → indeterminada", async () => {
    let pedidosNoDestino = 0;
    const destino = await servidor((s) => {
      pedidosNoDestino += 1;
      s.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    const base = await servidor((s) => s.end(`HTTP/1.1 307 Temporary Redirect\r\nLocation: ${destino}/roubo\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`));
    const r = await new ClienteHttpMetaWhatsapp(undefined, base).requisitar(req());
    expect(r).toMatchObject({ tipo: "resposta", status: 307 });
    expect(pedidosNoDestino).toBe(0);
    expect(classificarRespostaEnvio(r).resultado).toEqual({ resultado: "indeterminada", codigoProvedor: "HTTP_307" });
  });
});
