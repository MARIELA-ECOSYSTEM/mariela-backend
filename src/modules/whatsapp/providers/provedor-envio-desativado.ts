import { Injectable } from "@nestjs/common";
import type {
  EnviarTemplateWhatsappInput,
  EnviarTextoWhatsappInput,
  InfoTemplateProvedorWhatsapp,
  ProvedorEnvioWhatsapp,
  ResultadoEnvioProvedorWhatsapp,
} from "./provedor-envio-whatsapp.interface.js";

/**
 * Fase 22.8.9.10.3 — provedor PADRÃO: nunca configurado, nunca faz chamada de rede. Desde a Fase 22.8.9.10.4 continua
 * sendo o padrão (`criarProvedorEnvioWhatsapp`) e também o resultado de uma configuração da Meta incompleta. Com ele, as rotas de envio por template respondem `WHATSAPP_NOT_CONFIGURED` antes de gravar
 * qualquer coisa. Os testes substituem este provedor por um dublê (`overrideProvider`).
 */
@Injectable()
export class ProvedorEnvioDesativado implements ProvedorEnvioWhatsapp {
  readonly nome = "desativado";

  configurado(): boolean {
    return false;
  }

  async enviarTemplate(_input: EnviarTemplateWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp> {
    throw new Error("Provedor de envio por template não configurado.");
  }

  async enviarTexto(_input: EnviarTextoWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp> {
    throw new Error("Provedor de envio não configurado.");
  }

  async consultarTemplate(_nomeMeta: string, _idioma: string): Promise<InfoTemplateProvedorWhatsapp | null> {
    throw new Error("Provedor de envio por template não configurado.");
  }
}
