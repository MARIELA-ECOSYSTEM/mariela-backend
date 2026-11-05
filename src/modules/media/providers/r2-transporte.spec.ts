import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import type { Configuration, StorageConfig } from "../../../config/configuration.js";
import { S3ServiceException } from "@aws-sdk/client-s3";
import { TRANSPORTE_R2_PADRAO } from "../media.constants.js";
import { ehFalhaTransitoria, R2PresignerProvider } from "./r2-presigner.provider.js";

/**
 * Fase 60.4.1 — timeouts e tentativas das chamadas ao R2, com o SDK REAL (middlewares, assinatura, estratégia de
 * nova tentativa) falando com um servidor HTTP LOCAL (`Bun.serve` em 127.0.0.1) que faz o papel do R2. Nenhuma
 * chamada sai da máquina; credenciais fictícias.
 */

const SEGREDO = "segredo-ficticio-que-nunca-pode-aparecer";
const ACCESS_KEY = "AKIAFICTICIOTRANSPORTE";
const R2: StorageConfig["r2"] = { accountId: "conta", accessKeyId: ACCESS_KEY, secretAccessKey: SEGREDO, bucketName: "bucket", publicBaseUrl: "https://midia.exemplo.com" };

type Resposta = { status: number; corpo?: string | Uint8Array; cabecalhos?: Record<string, string> } | "pendurar";

/** Servidor local: responde conforme o roteiro e registra cada requisição recebida (método + caminho). */
const recebidas: string[] = [];
let roteiro: (indice: number, metodo: string) => Resposta = () => ({ status: 200 });
const penduradas: (() => void)[] = [];
let servidor: ReturnType<typeof Bun.serve>;

/** Provider REAL apontado para o servidor local (endereçamento por caminho: `/bucket/chave`). */
class R2Local extends R2PresignerProvider {
  constructor(config: ConfigService<Configuration>) {
    super(config);
  }
  protected override endpoint(): string {
    return `http://127.0.0.1:${servidor.port}`;
  }
  protected override enderecamentoPorCaminho(): boolean {
    return true;
  }
}

function provider(transporte?: StorageConfig["transporte"]): R2Local {
  return new R2Local(new ConfigService<Configuration>({ storage: transporte ? { r2: R2, transporte } : { r2: R2 } }));
}

const erroXml = (codigo: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${codigo}</Code><Message>simulado</Message></Error>`;

async function erroDe(promessa: Promise<unknown>): Promise<ApiException> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof ApiException) return erro;
    throw erro;
  }
  throw new Error("esperava falha");
}

describe("R2PresignerProvider — timeouts e novas tentativas (Fase 60.4.1, servidor local)", () => {
  beforeAll(() => {
    servidor = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (requisicao) => {
        const indice = recebidas.length;
        recebidas.push(`${requisicao.method} ${new URL(requisicao.url).pathname}`);
        const resposta = roteiro(indice, requisicao.method);
        if (resposta === "pendurar") {
          await new Promise<void>((liberar) => penduradas.push(liberar));
          return new Response(null, { status: 200 });
        }
        return new Response(resposta.corpo ?? (requisicao.method === "HEAD" ? null : ""), { status: resposta.status, headers: resposta.cabecalhos });
      },
    });
  });
  afterEach(() => {
    recebidas.length = 0;
    roteiro = () => ({ status: 200 });
    for (const liberar of penduradas.splice(0)) liberar();
  });
  afterAll(() => {
    servidor.stop(true);
  });

  const TRANSPORTE_RAPIDO = { timeoutConexaoMs: 500, timeoutRequisicaoMs: 300, maxTentativas: 2 };

  it("padrões do projeto quando nada é configurado: 3 s de conexão + 10 s de resposta por tentativa, 2 tentativas; prazos derivados", () => {
    const semConfig = provider();
    expect(semConfig.transporte()).toEqual(TRANSPORTE_R2_PADRAO);
    expect(TRANSPORTE_R2_PADRAO).toEqual({ timeoutConexaoMs: 3_000, timeoutRequisicaoMs: 10_000, maxTentativas: 2 });
    expect(semConfig.prazoPorTentativaMs()).toBe(13_000);
    expect(semConfig.prazoTotalMs()).toBe(2 * 13_000 + 250);
  });

  it("configuração explícita é respeitada (inclusive no prazo total)", () => {
    const configurado = provider({ timeoutConexaoMs: 1_000, timeoutRequisicaoMs: 2_000, maxTentativas: 3 });
    expect(configurado.transporte()).toEqual({ timeoutConexaoMs: 1_000, timeoutRequisicaoMs: 2_000, maxTentativas: 3 });
    expect(configurado.prazoTotalMs()).toBe(3 * 3_000 + 250 + 500);
  });

  it("falha transitória (503) seguida de sucesso: repete UMA vez e conclui", async () => {
    roteiro = (indice) => (indice === 0 ? { status: 503 } : { status: 200, cabecalhos: { "content-type": "image/jpeg" } });
    const resultado = await provider(TRANSPORTE_RAPIDO).inspecionarObjeto("products/p/a.jpg");
    expect(resultado).toMatchObject({ existe: true, contentType: "image/jpeg" });
    expect(recebidas).toEqual(["HEAD /bucket/products/p/a.jpg", "HEAD /bucket/products/p/a.jpg"]);
  });

  it("falhas transitórias persistentes (5xx e 429): param no limite de tentativas e viram STORAGE_UNAVAILABLE", async () => {
    for (const [status, codigo] of [[500, "InternalError"], [503, "ServiceUnavailable"], [429, "SlowDown"]] as const) {
      roteiro = () => ({ status, corpo: erroXml(codigo), cabecalhos: { "content-type": "application/xml" } });
      const erro = await erroDe(provider(TRANSPORTE_RAPIDO).excluirObjeto("products/p/a.jpg"));
      expect(erro.code).toBe("STORAGE_UNAVAILABLE");
      expect(recebidas).toHaveLength(2);
      recebidas.length = 0;
    }
    roteiro = () => ({ status: 503, corpo: erroXml("ServiceUnavailable"), cabecalhos: { "content-type": "application/xml" } });
    await erroDe(provider({ ...TRANSPORTE_RAPIDO, maxTentativas: 3 }).excluirObjeto("products/p/a.jpg"));
    expect(recebidas).toHaveLength(3);
  });

  it("erros permanentes NÃO são repetidos: 403 e 400 falham na primeira; 404 é resposta normal (ausente), também sem repetir", async () => {
    roteiro = () => ({ status: 403, corpo: erroXml("AccessDenied"), cabecalhos: { "content-type": "application/xml" } });
    expect((await erroDe(provider(TRANSPORTE_RAPIDO).excluirObjeto("products/p/a.jpg"))).code).toBe("STORAGE_UNAVAILABLE");
    expect(recebidas).toHaveLength(1);

    recebidas.length = 0;
    roteiro = () => ({ status: 400, corpo: erroXml("InvalidRequest"), cabecalhos: { "content-type": "application/xml" } });
    expect((await erroDe(provider(TRANSPORTE_RAPIDO).lerPrimeirosBytes("products/p/a.jpg", 16))).code).toBe("STORAGE_UNAVAILABLE");
    expect(recebidas).toHaveLength(1);

    recebidas.length = 0;
    roteiro = () => ({ status: 404 });
    expect(await provider(TRANSPORTE_RAPIDO).inspecionarObjeto("products/p/nao-existe.jpg")).toEqual({ existe: false });
    expect(recebidas).toHaveLength(1);

    recebidas.length = 0;
    roteiro = () => ({ status: 404, corpo: erroXml("NoSuchKey"), cabecalhos: { "content-type": "application/xml" } });
    expect(await provider(TRANSPORTE_RAPIDO).lerPrimeirosBytes("products/p/nao-existe.jpg", 16)).toBeNull();
    expect(recebidas).toHaveLength(1);
  });

  it("Range de leitura e resposta 206 continuam corretos através do transporte configurado", async () => {
    roteiro = () => ({ status: 206, corpo: new Uint8Array([0xff, 0xd8, 0xff]), cabecalhos: { "content-type": "image/jpeg", "content-range": "bytes 0-2/1024" } });
    expect(await provider(TRANSPORTE_RAPIDO).lerPrimeirosBytes("products/p/a.jpg", 16)).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(recebidas).toEqual(["GET /bucket/products/p/a.jpg"]);
  });

  it("servidor que aceita a conexão e nunca responde: cada tentativa é cortada no prazo (conexão + resposta), repete uma vez e termina em STORAGE_UNAVAILABLE dentro do prazo total", async () => {
    roteiro = () => "pendurar";
    const lento = provider(TRANSPORTE_RAPIDO);
    const inicio = Date.now();
    const erro = await erroDe(lento.inspecionarObjeto("products/p/a.jpg"));
    const decorrido = Date.now() - inicio;
    expect(erro.code).toBe("STORAGE_UNAVAILABLE");
    expect(recebidas).toHaveLength(2);
    expect(decorrido).toBeGreaterThanOrEqual(2 * lento.prazoPorTentativaMs() - 50);
    expect(decorrido).toBeLessThanOrEqual(lento.prazoTotalMs() + 500);
  });

  it("corpo lento na leitura por Range também respeita o prazo da tentativa", async () => {
    roteiro = (_indice, metodo) => (metodo === "GET" ? "pendurar" : { status: 200 });
    const lento = provider({ ...TRANSPORTE_RAPIDO, maxTentativas: 1 });
    const inicio = Date.now();
    expect((await erroDe(lento.lerPrimeirosBytes("products/p/a.jpg", 16))).code).toBe("STORAGE_UNAVAILABLE");
    expect(Date.now() - inicio).toBeLessThanOrEqual(lento.prazoTotalMs() + 500);
    expect(recebidas).toHaveLength(1);
  });

  /** Provider apontado para uma porta arbitrária de 127.0.0.1. */
  function providerNaPorta(porta: number, transporte: StorageConfig["transporte"]): R2PresignerProvider {
    class R2NaPorta extends R2PresignerProvider {
      protected override endpoint(): string {
        return `http://127.0.0.1:${porta}`;
      }
      protected override enderecamentoPorCaminho(): boolean {
        return true;
      }
    }
    return new R2NaPorta(new ConfigService<Configuration>({ storage: { r2: R2, transporte } }));
  }

  it("conexão encerrada sem resposta é transitória: uma conexão por tentativa, até o limite, e STORAGE_UNAVAILABLE", async () => {
    let conexoes = 0;
    const tcp = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          conexoes += 1;
          socket.end(); // aceita e fecha sem responder
        },
        data() {},
      },
    });
    try {
      expect((await erroDe(providerNaPorta(tcp.port, TRANSPORTE_RAPIDO).excluirObjeto("products/p/a.jpg"))).code).toBe("STORAGE_UNAVAILABLE");
      expect(conexoes).toBe(TRANSPORTE_RAPIDO.maxTentativas);
    } finally {
      tcp.stop(true);
    }
  });

  it("conexão recusada (porta fechada) é transitória: com 2 tentativas há a espera da nova tentativa; com 1, falha imediata", async () => {
    const fechado = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const porta = fechado.port;
    fechado.stop(true);
    if (porta === undefined) throw new Error("o servidor de teste não informou a porta");
    // A recusa chega em milissegundos: só a nova tentativa explica a espera de 250 ms.
    const duas = Date.now();
    expect((await erroDe(providerNaPorta(porta, TRANSPORTE_RAPIDO).excluirObjeto("products/p/a.jpg"))).code).toBe("STORAGE_UNAVAILABLE");
    expect(Date.now() - duas).toBeGreaterThanOrEqual(240);
    const uma = Date.now();
    expect((await erroDe(providerNaPorta(porta, { ...TRANSPORTE_RAPIDO, maxTentativas: 1 }).excluirObjeto("products/p/a.jpg"))).code).toBe("STORAGE_UNAVAILABLE");
    expect(Date.now() - uma).toBeLessThan(240);
  });

  it("o SDK não repete sozinho: cada tentativa da aplicação é uma única requisição (sem multiplicar camadas)", async () => {
    roteiro = () => ({ status: 503, corpo: erroXml("ServiceUnavailable"), cabecalhos: { "content-type": "application/xml" } });
    await erroDe(provider({ ...TRANSPORTE_RAPIDO, maxTentativas: 1 }).inspecionarObjeto("products/p/a.jpg"));
    expect(recebidas).toHaveLength(1);
  });

  it("classificação: 5xx, 429 e falhas de rede/prazo são transitórias; demais 4xx e erros de configuração são permanentes", () => {
    const sdk = (status: number) => new S3ServiceException({ name: `Erro${status}`, $fault: status >= 500 ? "server" : "client", $metadata: { httpStatusCode: status } });
    for (const status of [500, 502, 503, 504, 429]) expect(ehFalhaTransitoria(sdk(status))).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 412, 416]) expect(ehFalhaTransitoria(sdk(status))).toBe(false);
    const rede = (codigo: string) => Object.assign(new Error("falha de rede"), { code: codigo });
    for (const codigo of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]) expect(ehFalhaTransitoria(rede(codigo))).toBe(true);
    const prazo = new Error("tempo esgotado");
    prazo.name = "TimeoutError";
    expect(ehFalhaTransitoria(prazo)).toBe(true);
    const credencial = new Error("Could not load credentials");
    credencial.name = "CredentialsProviderError";
    expect(ehFalhaTransitoria(credencial)).toBe(false);
    expect(ehFalhaTransitoria(new Error("getaddrinfo ENOTFOUND"))).toBe(false);
    expect(ehFalhaTransitoria("texto")).toBe(false);
  });

  it("toda chamada de rede leva um sinal de abort (prazo da tentativa); a assinatura de URL não faz chamada nenhuma", async () => {
    const opcoesRecebidas: unknown[] = [];
    const espiao = spyOn(S3Client.prototype, "send").mockImplementation(async (_comando: unknown, opcoes: unknown) => {
      opcoesRecebidas.push(opcoes);
      return {};
    });
    try {
      const p = provider(TRANSPORTE_RAPIDO);
      await p.excluirObjeto("products/p/a.jpg");
      await p.inspecionarObjeto("products/p/a.jpg");
      await p.lerPrimeirosBytes("products/p/a.jpg", 16);
      expect(opcoesRecebidas).toHaveLength(3);
      for (const opcoes of opcoesRecebidas) expect((opcoes as { abortSignal: unknown }).abortSignal).toBeInstanceOf(AbortSignal);
    } finally {
      espiao.mockRestore();
    }
    const url = await provider(TRANSPORTE_RAPIDO).assinarUpload({ key: "products/p/a.jpg", contentType: "image/jpeg", contentLength: 10, expiresInSeconds: 600, cacheControl: "public, max-age=31536000, immutable" });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("600");
    expect(recebidas).toEqual([]);
  });

  it("nenhum segredo nos logs nem na resposta de erro, inclusive depois das novas tentativas", async () => {
    const logs: string[] = [];
    const espiao = spyOn(Logger.prototype, "warn").mockImplementation((mensagem: unknown) => {
      logs.push(String(mensagem));
    });
    try {
      roteiro = () => ({ status: 503, corpo: erroXml("ServiceUnavailable"), cabecalhos: { "content-type": "application/xml" } });
      const erro = await erroDe(provider(TRANSPORTE_RAPIDO).excluirObjeto("products/p/a.jpg"));
      const texto = JSON.stringify(erro.getResponse()) + logs.join("\n");
      expect(logs.length).toBeGreaterThan(0);
      expect(texto).not.toContain(SEGREDO);
      expect(texto).not.toContain(ACCESS_KEY);
      expect(texto).not.toContain("X-Amz-Signature");
    } finally {
      espiao.mockRestore();
    }
  });
});
