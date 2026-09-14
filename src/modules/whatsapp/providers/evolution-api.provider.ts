import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Configuration, WhatsappConfig } from "../../../config/configuration.js";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import type {
  EnviarTextoWhatsappInput,
  EnviarTextoWhatsappResultado,
  WhatsappProvider,
} from "./whatsapp-provider.interface.js";
import type { StatusConexaoWhatsapp, StatusWhatsapp } from "../whatsapp.types.js";

interface EvolutionConnectionStateResposta {
  instance?: { instanceName?: string; state?: string };
}

/**
 * Objeto de QR/pareamento devolvido pela Evolution API (`instance.qrCode`
 * internamente, tag 2.3.7). `base64` é a imagem PNG já como data URL
 * completa (`"data:image/png;base64,…"`); `code`/`pairingCode` são a string
 * de pareamento do protocolo Baileys — NUNCA bytes de imagem, não podem ser
 * envelopados como `data:image/png;base64,...`.
 */
interface EvolutionQrCodeData {
  base64?: string;
  code?: string;
  pairingCode?: string;
  count?: number;
}

/**
 * `connectToWhatsapp` (tag 2.3.7) devolve formatos diferentes por estado:
 * - `state === "open"`: mesma forma de `EvolutionConnectionStateResposta`
 *   (`{ instance: { instanceName, state } }`);
 * - `state === "connecting"` ou `"close"`: o objeto de QR diretamente no
 *   corpo (`EvolutionQrCodeData`, achatado — sem campo `instance`);
 * - estado desconhecido (fallback raro do controller real): `{ instance:
 *   { instanceName, status }, qrcode: EvolutionQrCodeData }` — note `qrcode`
 *   minúsculo e ANINHADO, formato distinto dos dois casos acima.
 */
interface EvolutionConnectResposta extends EvolutionQrCodeData {
  instance?: { state?: string; instanceName?: string; status?: string };
  qrcode?: EvolutionQrCodeData;
}

interface EvolutionSendTextResposta {
  key?: { id?: string };
}

interface RespostaBruta {
  status: number;
  ok: boolean;
  texto: string;
}

/**
 * Único ponto do backend que conhece o contrato HTTP da Evolution API
 * (endpoints, header `apikey`, formato de payload/resposta). Nenhum outro
 * módulo — nem `WhatsappService`, nem o controller, nem o frontend — deve
 * montar essa URL ou conhecer esse vocabulário (Etapa Pré-22, §2-3).
 *
 * Endpoints/métodos verificados diretamente contra o código-fonte oficial na
 * tag `2.3.7` (`instance.router.ts`/`instance.controller.ts`,
 * `EvolutionAPI/evolution-api`), não apenas documentação de terceiros —
 * achado da auditoria pós-commit desta etapa: `GET
 * /instance/connectionState/{instance}`, `GET /instance/connect/{instance}`
 * (QR), `DELETE /instance/logout/{instance}` e `POST
 * /message/sendText/{instance}` com corpo `{ number, text }`. O `logout`
 * real NÃO é idempotente por si só: chamar em uma instância já fechada
 * responde 400 (`"instance is not connected"`) — `desconectar()` abaixo
 * confirma o estado real via `connectionState` antes de tratar isso como
 * sucesso, em vez de presumir.
 */
@Injectable()
export class EvolutionApiProvider implements WhatsappProvider {
  private readonly logger = new Logger(EvolutionApiProvider.name);

  constructor(private readonly configService: ConfigService<Configuration>) {}

  private get config(): WhatsappConfig {
    return this.configService.get("whatsapp", { infer: true })!;
  }

  private configurado(config: WhatsappConfig): boolean {
    return config.evolution.apiUrl.trim() !== "" && config.evolution.apiKey.trim() !== "";
  }

  /**
   * Camada crua: só resolve rede/timeout, nunca interpreta o status HTTP —
   * quem decide o que um 400/401/403/404/5xx significa é cada chamador
   * (`chamar` aplica a interpretação padrão; `desconectar` aplica uma
   * interpretação própria para distinguir "já desconectado" de erro real).
   */
  private async chamarBruto(config: WhatsappConfig, metodo: string, caminho: string, corpo?: unknown): Promise<RespostaBruta> {
    const url = `${config.evolution.apiUrl.replace(/\/+$/, "")}${caminho}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.evolution.timeoutMs);

    let resposta: Response;
    try {
      resposta = await fetch(url, {
        method: metodo,
        headers: { "Content-Type": "application/json", apikey: config.evolution.apiKey },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
        signal: controller.signal,
      });
    } catch (erro) {
      if (erro instanceof Error && erro.name === "AbortError") {
        this.logger.warn(`Timeout ao chamar Evolution API (${metodo} ${caminho}).`);
        throw ApiException.whatsappTimeout();
      }
      this.logger.warn(
        `Evolution API indisponível (${metodo} ${caminho}): ${erro instanceof Error ? erro.message : "erro desconhecido"}`,
      );
      throw ApiException.evolutionUnavailable();
    } finally {
      clearTimeout(timer);
    }

    const texto = await resposta.text();
    return { status: resposta.status, ok: resposta.ok, texto };
  }

  /** Interpretação padrão de uma resposta não-2xx: 404 = instância inexistente/sem sessão; qualquer outro (400/401/403/5xx) = falha externa genérica (o status real fica no log, para diagnóstico). */
  private garantirRespostaOk(resposta: RespostaBruta, metodo: string, caminho: string): void {
    if (resposta.ok) return;
    if (resposta.status === 404) {
      throw ApiException.whatsappNotConnected("Instância do WhatsApp não encontrada na Evolution API.");
    }
    this.logger.warn(`Evolution API respondeu ${resposta.status} para ${metodo} ${caminho}.`);
    throw ApiException.evolutionUnavailable();
  }

  private async chamar<T>(config: WhatsappConfig, metodo: string, caminho: string, corpo?: unknown): Promise<T> {
    const resposta = await this.chamarBruto(config, metodo, caminho, corpo);
    this.garantirRespostaOk(resposta, metodo, caminho);
    return (resposta.texto ? JSON.parse(resposta.texto) : {}) as T;
  }

  async obterStatus(): Promise<StatusWhatsapp> {
    const config = this.config;
    if (!this.configurado(config)) {
      return this.montarStatus(config, "NOT_CONFIGURED", null);
    }

    try {
      const resposta = await this.chamar<EvolutionConnectionStateResposta>(
        config,
        "GET",
        `/instance/connectionState/${config.evolution.instanceName}`,
      );
      return this.montarStatus(config, this.mapearEstado(resposta.instance?.state), null);
    } catch (erro) {
      if (erro instanceof ApiException && erro.code === "WHATSAPP_NOT_CONNECTED") {
        return this.montarStatus(config, "DISCONNECTED", null);
      }
      throw erro;
    }
  }

  async conectar(): Promise<StatusWhatsapp> {
    const config = this.config;
    if (!this.configurado(config)) throw ApiException.whatsappNotConfigured();

    const resposta = await this.chamar<EvolutionConnectResposta>(
      config,
      "GET",
      `/instance/connect/${config.evolution.instanceName}`,
    );

    if (resposta.instance?.state === "open") {
      return this.montarStatus(config, "CONNECTED", null);
    }

    return this.montarStatus(config, ...this.extrairQrCode(resposta));
  }

  /**
   * Só aceita imagem PNG/base64 já pronta — nunca fabrica uma a partir de
   * `code`/`pairingCode` (strings de pareamento do protocolo Baileys, não
   * bytes de imagem). Checa a forma achatada (`resposta.base64`, caso
   * `connecting`/`close`) e a forma aninhada (`resposta.qrcode.base64`, caso
   * de fallback de estado desconhecido) — nenhuma outra é aceita. Se não
   * houver imagem em nenhuma das duas, devolve ausência de QR de forma
   * controlada (`CONNECTING`, sem `qrCode`), nunca um valor inventado.
   */
  private extrairQrCode(resposta: EvolutionConnectResposta): [StatusConexaoWhatsapp, string | null] {
    const base64 = resposta.base64 ?? resposta.qrcode?.base64 ?? null;
    return [base64 ? "QRCODE" : "CONNECTING", base64];
  }

  async desconectar(): Promise<StatusWhatsapp> {
    const config = this.config;
    if (!this.configurado(config)) throw ApiException.whatsappNotConfigured();

    const caminho = `/instance/logout/${config.evolution.instanceName}`;
    const resposta = await this.chamarBruto(config, "DELETE", caminho);

    if (resposta.ok) {
      return this.montarStatus(config, "DISCONNECTED", null);
    }

    if (resposta.status === 400) {
      // A Evolution API real responde 400 quando a instância já está fechada
      // (`instance.controller.ts#logout`, tag 2.3.7: "... instance is not
      // connected"). Não presumimos isso só pelo status — confirmamos o
      // estado real via connectionState antes de tratar como sucesso
      // idempotente; qualquer outro motivo de 400 continua sendo erro.
      const statusAtual = await this.obterStatus();
      if (statusAtual.status === "DISCONNECTED") {
        return statusAtual;
      }
    }

    this.garantirRespostaOk(resposta, "DELETE", caminho);
    // Inatingível: `garantirRespostaOk` sempre lança quando `resposta.ok` é falso.
    throw ApiException.evolutionUnavailable();
  }

  async enviarTexto(input: EnviarTextoWhatsappInput): Promise<EnviarTextoWhatsappResultado> {
    const config = this.config;
    if (!this.configurado(config)) throw ApiException.whatsappNotConfigured();

    // A Evolution API espera o número sem o `+` do E.164.
    const numero = input.telefone.replace(/^\+/, "");
    const resposta = await this.chamar<EvolutionSendTextResposta>(
      config,
      "POST",
      `/message/sendText/${config.evolution.instanceName}`,
      { number: numero, text: input.mensagem },
    );

    // Nunca reportar sucesso só porque a chamada HTTP terminou com 2xx: a
    // Evolution API só confirma o envio com um `key.id` de mensagem real.
    if (!resposta.key?.id) {
      throw ApiException.whatsappSendFailed();
    }

    return { idExterno: resposta.key.id };
  }

  private mapearEstado(estado: string | undefined): StatusConexaoWhatsapp {
    switch (estado) {
      case "open":
        return "CONNECTED";
      case "connecting":
        return "CONNECTING";
      case "close":
        return "DISCONNECTED";
      default:
        return "ERROR";
    }
  }

  private montarStatus(config: WhatsappConfig, status: StatusConexaoWhatsapp, qrCode: string | null): StatusWhatsapp {
    return {
      provider: "evolution-api",
      transporte: "baileys",
      instance: config.evolution.instanceName,
      status,
      numero: config.ownerPhone.trim() || null,
      qrCode,
    };
  }
}
