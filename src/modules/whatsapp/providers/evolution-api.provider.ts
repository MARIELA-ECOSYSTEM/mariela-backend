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

/** Formatos observados na documentação/comunidade da Evolution API v2 para estas respostas — apenas os campos que este provider realmente lê. */
interface EvolutionConnectionStateResposta {
  instance?: { instanceName?: string; state?: string };
}
interface EvolutionConnectResposta {
  base64?: string;
  code?: string;
  instance?: { state?: string };
}
interface EvolutionSendTextResposta {
  key?: { id?: string };
}

/**
 * Único ponto do backend que conhece o contrato HTTP da Evolution API
 * (endpoints, header `apikey`, formato de payload/resposta). Nenhum outro
 * módulo — nem `WhatsappService`, nem o controller, nem o frontend — deve
 * montar essa URL ou conhecer esse vocabulário (Etapa Pré-22, §2-3).
 *
 * Verificado contra a documentação pública da Evolution API v2 em vigor
 * nesta etapa: header de autenticação `apikey` (chave global, não o `hash`
 * por instância — decisão explícita para não precisar persistir um segundo
 * segredo), `GET /instance/connectionState/{instance}`,
 * `GET /instance/connect/{instance}` (QR code), `POST /instance/logout/{instance}`
 * (idempotente — desconectar uma instância já desconectada responde OK, não
 * erro) e `POST /message/sendText/{instance}` com corpo `{ number, text }`.
 * O verbo exato de `logout` variou entre fontes secundárias consultadas
 * durante esta etapa (a documentação oficial não pôde ser renderizada por
 * fetch automatizado) — reconfirmar contra o Swagger da versão realmente
 * implantada (`{EVOLUTION_API_URL}/docs` ou `/manager`) antes de operar em
 * produção; ver relatório desta etapa, seção "Limitações".
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

  private async chamar<T>(config: WhatsappConfig, metodo: string, caminho: string, corpo?: unknown): Promise<T> {
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

    if (resposta.status === 404) {
      throw ApiException.whatsappNotConnected("Instância do WhatsApp não encontrada na Evolution API.");
    }
    if (!resposta.ok) {
      this.logger.warn(`Evolution API respondeu ${resposta.status} para ${metodo} ${caminho}.`);
      throw ApiException.evolutionUnavailable();
    }

    return (await resposta.json()) as T;
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

    const qrCode = resposta.base64 ?? (resposta.code ? `data:image/png;base64,${resposta.code}` : null);
    return this.montarStatus(config, qrCode ? "QRCODE" : "CONNECTING", qrCode);
  }

  async desconectar(): Promise<StatusWhatsapp> {
    const config = this.config;
    if (!this.configurado(config)) throw ApiException.whatsappNotConfigured();

    // Idempotente por design da Evolution API: desconectar uma instância já
    // desconectada responde OK, não erro — nunca mascaramos isso como falha.
    await this.chamar(config, "POST", `/instance/logout/${config.evolution.instanceName}`);
    return this.montarStatus(config, "DISCONNECTED", null);
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
