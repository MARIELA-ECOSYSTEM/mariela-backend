import { Injectable } from "@nestjs/common";
import type {
  EnviarTemplateWhatsappInput,
  InfoTemplateProvedorWhatsapp,
  ProvedorEnvioWhatsapp,
  ResultadoEnvioProvedorWhatsapp,
} from "./provedor-envio-whatsapp.interface.js";

/**
 * Fase 22.8.9.10.3 — provedor PADRÃO enquanto a Cloud API não existe (Fase 22.8.9.10.4): nunca configurado, nunca
 * faz chamada de rede. Com ele, as rotas de envio por template respondem `WHATSAPP_NOT_CONFIGURED` antes de gravar
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

  async consultarTemplate(_nomeMeta: string, _idioma: string): Promise<InfoTemplateProvedorWhatsapp | null> {
    throw new Error("Provedor de envio por template não configurado.");
  }
}
