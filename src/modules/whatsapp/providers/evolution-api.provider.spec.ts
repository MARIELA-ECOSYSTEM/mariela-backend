import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ConfigService } from "@nestjs/config";
import type { Configuration } from "../../../config/configuration.js";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import { EvolutionApiProvider } from "./evolution-api.provider.js";

/**
 * Nunca faz chamada HTTP real: `globalThis.fetch` é substituído por um dublê
 * controlado em cada teste e restaurado ao final — nenhuma credencial real é
 * usada (Etapa Pré-22, §39: "mockar a chamada HTTP").
 *
 * Fase 55.9 — via `spyOn(...).mockImplementation` (tipado pela assinatura real
 * de `fetch`) em vez de atribuir uma função com `as typeof fetch`: o `fetch` do
 * Bun também tem `preconnect`, então o cast escondia uma assinatura incompatível.
 */
type ImplementacaoFetch = (url: string, init?: RequestInit) => Promise<Response>;

function simularFetch(implementacao: ImplementacaoFetch) {
  // `mockImplementation` exige o tipo completo de `fetch`: a função de chamada
  // mais o `preconnect` real (não usado pelo provider), sem cast.
  const fetchFalso = Object.assign(
    (entrada: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => implementacao(String(entrada), init),
    { preconnect: globalThis.fetch.preconnect },
  );
  return spyOn(globalThis, "fetch").mockImplementation(fetchFalso);
}

function configServiceFake(overrides: Partial<Configuration["whatsapp"]["evolution"]> = {}): ConfigService<Configuration> {
  const whatsapp: Configuration["whatsapp"] = {
    ownerPhone: "+5583986567915",
    evolution: {
      apiUrl: "http://evolution.teste.local",
      apiKey: "chave-de-teste-nao-real",
      instanceName: "mariela-whatsapp-teste",
      timeoutMs: 1000,
      ...overrides,
    },
  };
  return { get: () => whatsapp } as unknown as ConfigService<Configuration>;
}

function respostaJson(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
}

describe("EvolutionApiProvider", () => {
  afterEach(() => {
    mock.restore();
  });

  describe("obterStatus", () => {
    it("responde NOT_CONFIGURED quando apiUrl/apiKey estão vazios, sem chamar a rede", async () => {
      let chamou = false;
      simularFetch(async () => {
        chamou = true;
        return respostaJson({});
      });

      const provider = new EvolutionApiProvider(configServiceFake({ apiUrl: "", apiKey: "" }));
      const status = await provider.obterStatus();

      expect(status.status).toBe("NOT_CONFIGURED");
      expect(chamou).toBe(false);
    });

    it("mapeia state=open para CONNECTED e devolve o número owner configurado", async () => {
      simularFetch(async (url: string) => {
        expect(url).toContain("/instance/connectionState/mariela-whatsapp-teste");
        return respostaJson({ instance: { instanceName: "mariela-whatsapp-teste", state: "open" } });
      });

      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.obterStatus();

      expect(status.status).toBe("CONNECTED");
      expect(status.provider).toBe("evolution-api");
      expect(status.transporte).toBe("baileys");
      expect(status.numero).toBe("+5583986567915");
    });

    it("mapeia state=close para DISCONNECTED", async () => {
      simularFetch(async () => respostaJson({ instance: { state: "close" } }));
      const provider = new EvolutionApiProvider(configServiceFake());
      expect((await provider.obterStatus()).status).toBe("DISCONNECTED");
    });

    it("trata 404 (instância inexistente) como DISCONNECTED, não como erro", async () => {
      simularFetch(async () => respostaJson({ message: "not found" }, 404));
      const provider = new EvolutionApiProvider(configServiceFake());
      expect((await provider.obterStatus()).status).toBe("DISCONNECTED");
    });

    it("envia o header apikey em toda chamada", async () => {
      const espiao = simularFetch(async () => respostaJson({ instance: { state: "open" } }));

      const provider = new EvolutionApiProvider(configServiceFake({ apiKey: "chave-secreta-de-teste" }));
      await provider.obterStatus();

      const init = espiao.mock.calls[0]?.[1];
      expect(new Headers(init?.headers).get("apikey")).toBe("chave-secreta-de-teste");
    });
  });

  describe("conectar", () => {
    it("lança WHATSAPP_NOT_CONFIGURED quando a integração não está configurada", async () => {
      const provider = new EvolutionApiProvider(configServiceFake({ apiUrl: "" }));
      await expect(provider.conectar()).rejects.toThrow(ApiException);
    });

    it("devolve status CONNECTED quando instance.state já é open", async () => {
      simularFetch(async () => respostaJson({ instance: { state: "open" } }));
      const provider = new EvolutionApiProvider(configServiceFake());
      expect((await provider.conectar()).status).toBe("CONNECTED");
    });

    it("devolve o QR code em base64 quando presente na resposta (forma achatada — connecting/close)", async () => {
      simularFetch(async () => respostaJson({ base64: "data:image/png;base64,ABC123" }));
      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.conectar();
      expect(status.status).toBe("QRCODE");
      expect(status.qrCode).toBe("data:image/png;base64,ABC123");
    });

    it("devolve o QR code quando vem na forma aninhada `qrcode.base64` (fallback de estado desconhecido)", async () => {
      simularFetch(async () =>
        respostaJson({
          instance: { instanceName: "mariela-whatsapp-teste", status: "algum-estado-nao-mapeado" },
          qrcode: { base64: "data:image/png;base64,ANINHADO", code: "2@pareamento" },
        }));
      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.conectar();
      expect(status.status).toBe("QRCODE");
      expect(status.qrCode).toBe("data:image/png;base64,ANINHADO");
    });

    it("NUNCA fabrica uma imagem a partir de `code` (string de pareamento, não bytes de PNG) — devolve CONNECTING sem QR", async () => {
      simularFetch(async () => respostaJson({ code: "2@y8eK+bjtEjUWy9/algum-pareamento", count: 1 }));
      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.conectar();
      expect(status.status).toBe("CONNECTING");
      expect(status.qrCode).toBeNull();
    });

    it("devolve CONNECTING quando não há QR nem estado open", async () => {
      simularFetch(async () => respostaJson({}));
      const provider = new EvolutionApiProvider(configServiceFake());
      expect((await provider.conectar()).status).toBe("CONNECTING");
    });
  });

  describe("desconectar", () => {
    it("chama DELETE /instance/logout (não POST) — corrigido na auditoria pós-commit contra o router real da Evolution API 2.3.7", async () => {
      let metodoUsado = "";
      simularFetch(async (url: string, init?: RequestInit) => {
        metodoUsado = init?.method ?? "";
        expect(url).toContain("/instance/logout/mariela-whatsapp-teste");
        return respostaJson({ status: "SUCCESS" });
      });

      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.desconectar();

      expect(metodoUsado).toBe("DELETE");
      expect(status.status).toBe("DISCONNECTED");
    });

    it("logout de instância aberta (2xx) devolve DISCONNECTED diretamente, sem consultar connectionState", async () => {
      let chamadasConnectionState = 0;
      simularFetch(async (url: string) => {
        if (url.includes("connectionState")) chamadasConnectionState += 1;
        return respostaJson({ status: "SUCCESS", error: false, response: { message: "Instance logged out" } });
      });

      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.desconectar();

      expect(status.status).toBe("DISCONNECTED");
      expect(chamadasConnectionState).toBe(0);
    });

    it("logout já desconectado (400 real da Evolution) é tratado como sucesso idempotente SOMENTE após confirmar via connectionState que o estado é close", async () => {
      simularFetch(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return respostaJson({ message: 'The "mariela-whatsapp-teste" instance is not connected' }, 400);
        }
        expect(url).toContain("/instance/connectionState/mariela-whatsapp-teste");
        return respostaJson({ instance: { instanceName: "mariela-whatsapp-teste", state: "close" } });
      });

      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.desconectar();

      expect(status.status).toBe("DISCONNECTED");
    });

    it("outro 400 (connectionState NÃO confirma close) continua sendo erro — não presume sucesso só pelo status", async () => {
      simularFetch(async (_url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return respostaJson({ message: "Bad Request — algum outro motivo" }, 400);
        }
        return respostaJson({ instance: { state: "open" } });
      });

      const provider = new EvolutionApiProvider(configServiceFake());
      try {
        await provider.desconectar();
        throw new Error("deveria ter lançado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).code).toBe("EVOLUTION_UNAVAILABLE");
      }
    });

    it("401 (autenticação) é propagado como erro, nunca como sucesso", async () => {
      simularFetch(async () => respostaJson({ message: "Unauthorized" }, 401));
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.desconectar()).rejects.toThrow(ApiException);
    });

    it("403 (autorização) é propagado como erro, nunca como sucesso", async () => {
      simularFetch(async () => respostaJson({ message: "Forbidden" }, 403));
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.desconectar()).rejects.toThrow(ApiException);
    });

    it("404 (instância inexistente) mantém o tratamento existente (WHATSAPP_NOT_CONNECTED)", async () => {
      simularFetch(async () => respostaJson({ message: "not found" }, 404));
      const provider = new EvolutionApiProvider(configServiceFake());
      try {
        await provider.desconectar();
        throw new Error("deveria ter lançado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).code).toBe("WHATSAPP_NOT_CONNECTED");
      }
    });

    it("500 (Evolution indisponível/falha externa) é propagado como EVOLUTION_UNAVAILABLE", async () => {
      simularFetch(async () => respostaJson({ message: "Internal Server Error" }, 500));
      const provider = new EvolutionApiProvider(configServiceFake());
      try {
        await provider.desconectar();
        throw new Error("deveria ter lançado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).code).toBe("EVOLUTION_UNAVAILABLE");
      }
    });

    it("timeout no logout lança WHATSAPP_TIMEOUT", async () => {
      simularFetch(async (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const erro = new Error("The operation was aborted.");
            erro.name = "AbortError";
            reject(erro);
          });
        });
      });

      const provider = new EvolutionApiProvider(configServiceFake({ timeoutMs: 20 }));
      try {
        await provider.desconectar();
        throw new Error("deveria ter lançado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).code).toBe("WHATSAPP_TIMEOUT");
      }
    });
  });

  describe("enviarTexto", () => {
    it("monta number sem o `+` e text corretamente, e devolve o id da mensagem", async () => {
      let corpoEnviado: { number?: string; text?: string } = {};
      simularFetch(async (url: string, init?: RequestInit) => {
        expect(url).toContain("/message/sendText/mariela-whatsapp-teste");
        corpoEnviado = JSON.parse(String(init?.body));
        return respostaJson({ key: { id: "msg-123", remoteJid: "5583999991111@s.whatsapp.net" } });
      });

      const provider = new EvolutionApiProvider(configServiceFake());
      const resultado = await provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" });

      expect(corpoEnviado.number).toBe("5583999991111");
      expect(corpoEnviado.text).toBe("Olá!");
      expect(resultado.idExterno).toBe("msg-123");
    });

    it("nunca reporta sucesso se a resposta não trouxer key.id (não mascara erro como sucesso)", async () => {
      simularFetch(async () => respostaJson({}));
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 400 do provider como erro normalizado (nunca sucesso)", async () => {
      simularFetch(async () => respostaJson({ message: "Bad Request" }, 400));
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 401 do provider como erro normalizado", async () => {
      simularFetch(async () => respostaJson({ message: "Unauthorized" }, 401));
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 403 do provider como erro normalizado", async () => {
      simularFetch(async () => respostaJson({ message: "Forbidden" }, 403));
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 429 do provider como erro normalizado", async () => {
      simularFetch(async () => respostaJson({ message: "Too Many Requests" }, 429));
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 500 do provider como EVOLUTION_UNAVAILABLE", async () => {
      simularFetch(async () => respostaJson({ message: "Internal Server Error" }, 500));
      const provider = new EvolutionApiProvider(configServiceFake());
      try {
        await provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" });
        throw new Error("deveria ter lançado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).code).toBe("EVOLUTION_UNAVAILABLE");
      }
    });

    it("trata resposta inesperada (JSON sem os campos esperados) como falha de envio, não como sucesso", async () => {
      simularFetch(async () => respostaJson({ algumCampoInesperado: true }));
      const provider = new EvolutionApiProvider(configServiceFake());
      try {
        await provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" });
        throw new Error("deveria ter lançado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).code).toBe("WHATSAPP_SEND_FAILED");
      }
    });

    it("lança WHATSAPP_TIMEOUT quando a chamada excede o timeout configurado", async () => {
      simularFetch(async (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const erro = new Error("The operation was aborted.");
            erro.name = "AbortError";
            reject(erro);
          });
        });
      });

      const provider = new EvolutionApiProvider(configServiceFake({ timeoutMs: 20 }));
      try {
        await provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" });
        throw new Error("deveria ter lançado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).code).toBe("WHATSAPP_TIMEOUT");
      }
    });

    it("lança EVOLUTION_UNAVAILABLE quando a rede falha (fetch rejeita sem ser abort)", async () => {
      simularFetch(async () => {
        throw new Error("connect ECONNREFUSED");
      });

      const provider = new EvolutionApiProvider(configServiceFake());
      try {
        await provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" });
        throw new Error("deveria ter lançado");
      } catch (erro) {
        expect(erro).toBeInstanceOf(ApiException);
        expect((erro as ApiException).code).toBe("EVOLUTION_UNAVAILABLE");
      }
    });
  });
});
