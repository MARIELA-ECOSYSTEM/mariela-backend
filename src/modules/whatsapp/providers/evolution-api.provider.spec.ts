import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ConfigService } from "@nestjs/config";
import type { Configuration } from "../../../config/configuration.js";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import { EvolutionApiProvider } from "./evolution-api.provider.js";

/**
 * Nunca faz chamada HTTP real: `globalThis.fetch` é substituído por um dublê
 * controlado em cada teste e restaurado ao final — nenhuma credencial real é
 * usada (Etapa Pré-22, §39: "mockar a chamada HTTP").
 */
const fetchOriginal = globalThis.fetch;

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
    globalThis.fetch = fetchOriginal;
  });

  describe("obterStatus", () => {
    it("responde NOT_CONFIGURED quando apiUrl/apiKey estão vazios, sem chamar a rede", async () => {
      let chamou = false;
      globalThis.fetch = (async () => {
        chamou = true;
        return respostaJson({});
      }) as typeof fetch;

      const provider = new EvolutionApiProvider(configServiceFake({ apiUrl: "", apiKey: "" }));
      const status = await provider.obterStatus();

      expect(status.status).toBe("NOT_CONFIGURED");
      expect(chamou).toBe(false);
    });

    it("mapeia state=open para CONNECTED e devolve o número owner configurado", async () => {
      globalThis.fetch = (async (url: string) => {
        expect(url).toContain("/instance/connectionState/mariela-whatsapp-teste");
        return respostaJson({ instance: { instanceName: "mariela-whatsapp-teste", state: "open" } });
      }) as typeof fetch;

      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.obterStatus();

      expect(status.status).toBe("CONNECTED");
      expect(status.provider).toBe("evolution-api");
      expect(status.transporte).toBe("baileys");
      expect(status.numero).toBe("+5583986567915");
    });

    it("mapeia state=close para DISCONNECTED", async () => {
      globalThis.fetch = (async () => respostaJson({ instance: { state: "close" } })) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      expect((await provider.obterStatus()).status).toBe("DISCONNECTED");
    });

    it("trata 404 (instância inexistente) como DISCONNECTED, não como erro", async () => {
      globalThis.fetch = (async () => respostaJson({ message: "not found" }, 404)) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      expect((await provider.obterStatus()).status).toBe("DISCONNECTED");
    });

    it("envia o header apikey em toda chamada", async () => {
      let headerRecebido: string | null = null;
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        headerRecebido = (init?.headers as Record<string, string>)["apikey"] ?? null;
        return respostaJson({ instance: { state: "open" } });
      }) as typeof fetch;

      const provider = new EvolutionApiProvider(configServiceFake({ apiKey: "chave-secreta-de-teste" }));
      await provider.obterStatus();

      expect(headerRecebido).toBe("chave-secreta-de-teste");
    });
  });

  describe("conectar", () => {
    it("lança WHATSAPP_NOT_CONFIGURED quando a integração não está configurada", async () => {
      const provider = new EvolutionApiProvider(configServiceFake({ apiUrl: "" }));
      await expect(provider.conectar()).rejects.toThrow(ApiException);
    });

    it("devolve status CONNECTED quando instance.state já é open", async () => {
      globalThis.fetch = (async () => respostaJson({ instance: { state: "open" } })) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      expect((await provider.conectar()).status).toBe("CONNECTED");
    });

    it("devolve o QR code em base64 quando presente na resposta (forma achatada — connecting/close)", async () => {
      globalThis.fetch = (async () => respostaJson({ base64: "data:image/png;base64,ABC123" })) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.conectar();
      expect(status.status).toBe("QRCODE");
      expect(status.qrCode).toBe("data:image/png;base64,ABC123");
    });

    it("devolve o QR code quando vem na forma aninhada `qrcode.base64` (fallback de estado desconhecido)", async () => {
      globalThis.fetch = (async () =>
        respostaJson({
          instance: { instanceName: "mariela-whatsapp-teste", status: "algum-estado-nao-mapeado" },
          qrcode: { base64: "data:image/png;base64,ANINHADO", code: "2@pareamento" },
        })) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.conectar();
      expect(status.status).toBe("QRCODE");
      expect(status.qrCode).toBe("data:image/png;base64,ANINHADO");
    });

    it("NUNCA fabrica uma imagem a partir de `code` (string de pareamento, não bytes de PNG) — devolve CONNECTING sem QR", async () => {
      globalThis.fetch = (async () => respostaJson({ code: "2@y8eK+bjtEjUWy9/algum-pareamento", count: 1 })) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.conectar();
      expect(status.status).toBe("CONNECTING");
      expect(status.qrCode).toBeNull();
    });

    it("devolve CONNECTING quando não há QR nem estado open", async () => {
      globalThis.fetch = (async () => respostaJson({})) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      expect((await provider.conectar()).status).toBe("CONNECTING");
    });
  });

  describe("desconectar", () => {
    it("chama DELETE /instance/logout (não POST) — corrigido na auditoria pós-commit contra o router real da Evolution API 2.3.7", async () => {
      let metodoUsado = "";
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        metodoUsado = init?.method ?? "";
        expect(url).toContain("/instance/logout/mariela-whatsapp-teste");
        return respostaJson({ status: "SUCCESS" });
      }) as typeof fetch;

      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.desconectar();

      expect(metodoUsado).toBe("DELETE");
      expect(status.status).toBe("DISCONNECTED");
    });

    it("logout de instância aberta (2xx) devolve DISCONNECTED diretamente, sem consultar connectionState", async () => {
      let chamadasConnectionState = 0;
      globalThis.fetch = (async (url: string) => {
        if (url.includes("connectionState")) chamadasConnectionState += 1;
        return respostaJson({ status: "SUCCESS", error: false, response: { message: "Instance logged out" } });
      }) as typeof fetch;

      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.desconectar();

      expect(status.status).toBe("DISCONNECTED");
      expect(chamadasConnectionState).toBe(0);
    });

    it("logout já desconectado (400 real da Evolution) é tratado como sucesso idempotente SOMENTE após confirmar via connectionState que o estado é close", async () => {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return respostaJson({ message: 'The "mariela-whatsapp-teste" instance is not connected' }, 400);
        }
        expect(url).toContain("/instance/connectionState/mariela-whatsapp-teste");
        return respostaJson({ instance: { instanceName: "mariela-whatsapp-teste", state: "close" } });
      }) as typeof fetch;

      const provider = new EvolutionApiProvider(configServiceFake());
      const status = await provider.desconectar();

      expect(status.status).toBe("DISCONNECTED");
    });

    it("outro 400 (connectionState NÃO confirma close) continua sendo erro — não presume sucesso só pelo status", async () => {
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return respostaJson({ message: "Bad Request — algum outro motivo" }, 400);
        }
        return respostaJson({ instance: { state: "open" } });
      }) as typeof fetch;

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
      globalThis.fetch = (async () => respostaJson({ message: "Unauthorized" }, 401)) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.desconectar()).rejects.toThrow(ApiException);
    });

    it("403 (autorização) é propagado como erro, nunca como sucesso", async () => {
      globalThis.fetch = (async () => respostaJson({ message: "Forbidden" }, 403)) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.desconectar()).rejects.toThrow(ApiException);
    });

    it("404 (instância inexistente) mantém o tratamento existente (WHATSAPP_NOT_CONNECTED)", async () => {
      globalThis.fetch = (async () => respostaJson({ message: "not found" }, 404)) as typeof fetch;
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
      globalThis.fetch = (async () => respostaJson({ message: "Internal Server Error" }, 500)) as typeof fetch;
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
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const erro = new Error("The operation was aborted.");
            erro.name = "AbortError";
            reject(erro);
          });
        });
      }) as typeof fetch;

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
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        expect(url).toContain("/message/sendText/mariela-whatsapp-teste");
        corpoEnviado = JSON.parse(String(init?.body));
        return respostaJson({ key: { id: "msg-123", remoteJid: "5583999991111@s.whatsapp.net" } });
      }) as typeof fetch;

      const provider = new EvolutionApiProvider(configServiceFake());
      const resultado = await provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" });

      expect(corpoEnviado.number).toBe("5583999991111");
      expect(corpoEnviado.text).toBe("Olá!");
      expect(resultado.idExterno).toBe("msg-123");
    });

    it("nunca reporta sucesso se a resposta não trouxer key.id (não mascara erro como sucesso)", async () => {
      globalThis.fetch = (async () => respostaJson({})) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 400 do provider como erro normalizado (nunca sucesso)", async () => {
      globalThis.fetch = (async () => respostaJson({ message: "Bad Request" }, 400)) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 401 do provider como erro normalizado", async () => {
      globalThis.fetch = (async () => respostaJson({ message: "Unauthorized" }, 401)) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 403 do provider como erro normalizado", async () => {
      globalThis.fetch = (async () => respostaJson({ message: "Forbidden" }, 403)) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 429 do provider como erro normalizado", async () => {
      globalThis.fetch = (async () => respostaJson({ message: "Too Many Requests" }, 429)) as typeof fetch;
      const provider = new EvolutionApiProvider(configServiceFake());
      await expect(provider.enviarTexto({ telefone: "+5583999991111", mensagem: "Olá!" })).rejects.toThrow(ApiException);
    });

    it("propaga HTTP 500 do provider como EVOLUTION_UNAVAILABLE", async () => {
      globalThis.fetch = (async () => respostaJson({ message: "Internal Server Error" }, 500)) as typeof fetch;
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
      globalThis.fetch = (async () => respostaJson({ algumCampoInesperado: true })) as typeof fetch;
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
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const erro = new Error("The operation was aborted.");
            erro.name = "AbortError";
            reject(erro);
          });
        });
      }) as typeof fetch;

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
      globalThis.fetch = (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch;

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
