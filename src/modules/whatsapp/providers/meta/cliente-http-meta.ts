import { ERROS_REDE_SEM_CONEXAO, META_GRAPH_BASE_URL } from "./meta-cloud-api.constants.js";

/** Assinatura mínima de `fetch` — substituível nos testes (nenhum teste faz chamada real à Meta). */
export type FetchMeta = (url: string, init: RequestInit) => Promise<Response>;

export interface RequisicaoMeta {
  metodo: "GET" | "POST";
  /** Caminho a partir da versão, ex.: `/v26.0/123/messages`. Montado só pelo adaptador. */
  caminho: string;
  query?: Record<string, string>;
  corpo?: unknown;
  token: string;
  timeoutMs: number;
}

/**
 * Resultado CRU da chamada — sem interpretação de negócio:
 * - `resposta`: a Meta respondeu (qualquer status); `corpo` é o texto completo;
 * - `sem_conexao`: a conexão nem foi estabelecida (recusada/DNS) — comprovadamente nada saiu;
 * - `timeout`: o prazo venceu em qualquer ponto (antes, durante ou depois do envio, inclusive lendo o corpo);
 * - `interrompida`: a conexão caiu ou houve erro desconhecido — o pedido PODE ter chegado.
 */
export type RespostaHttpMeta =
  | { tipo: "resposta"; status: number; corpo: string }
  | { tipo: "sem_conexao"; motivo: "CONEXAO_RECUSADA" | "DNS" }
  | { tipo: "timeout" }
  | { tipo: "interrompida" };

function codigoDoErro(erro: unknown): string | null {
  if (typeof erro !== "object" || erro === null) return null;
  const e = erro as { code?: unknown; cause?: { code?: unknown } };
  if (typeof e.code === "string") return e.code;
  if (typeof e.cause?.code === "string") return e.cause.code;
  return null;
}

/**
 * Fase 22.8.9.10.4 — cliente HTTP ISOLADO da Cloud API. Regras:
 * - UMA tentativa por chamada: nenhum retry aqui nem em camada alguma (um retry pode duplicar a mensagem);
 * - timeout explícito cobrindo também a leitura do corpo;
 * - redirecionamento nunca seguido (`redirect: "manual"`): o header `Authorization` nunca vai para outro host;
 * - nada é logado aqui, e nenhuma exceção sai daqui (o token nunca aparece em erro).
 */
export class ClienteHttpMetaWhatsapp {
  constructor(
    private readonly fetchImpl: FetchMeta = (url, init) => fetch(url, init),
    private readonly baseUrl: string = META_GRAPH_BASE_URL,
  ) {}

  async requisitar(req: RequisicaoMeta): Promise<RespostaHttpMeta> {
    const url = new URL(`${this.baseUrl}${req.caminho}`);
    for (const [chave, valor] of Object.entries(req.query ?? {})) url.searchParams.set(chave, valor);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const resposta = await this.fetchImpl(url.toString(), {
        method: req.metodo,
        headers: {
          Authorization: `Bearer ${req.token}`,
          Accept: "application/json",
          ...(req.corpo !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: req.corpo !== undefined ? JSON.stringify(req.corpo) : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      const corpo = await resposta.text();
      return { tipo: "resposta", status: resposta.status, corpo };
    } catch (erro) {
      if (controller.signal.aborted) return { tipo: "timeout" };
      const codigo = codigoDoErro(erro);
      const semConexao = codigo ? ERROS_REDE_SEM_CONEXAO.get(codigo) : undefined;
      if (semConexao) return { tipo: "sem_conexao", motivo: semConexao };
      return { tipo: "interrompida" };
    } finally {
      clearTimeout(timer);
    }
  }
}
