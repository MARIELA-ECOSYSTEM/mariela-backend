import type { StatusWhatsapp } from "../whatsapp.types.js";

export interface EnviarTextoWhatsappInput {
  /** Telefone destinatário já normalizado em E.164 (`+55DDDNNNNNNNNN`). */
  telefone: string;
  mensagem: string;
}

export interface EnviarTextoWhatsappResultado {
  /** Id da mensagem no provider externo, quando disponível (nunca inventado quando ausente). */
  idExterno: string | null;
}

/**
 * Abstração de provider de WhatsApp (Etapa Pré-22, §19). Nenhum service de
 * domínio deve conhecer detalhes de HTTP/autenticação de um provider
 * específico — apenas este contrato. Hoje só existe `EvolutionApiProvider`;
 * um futuro `MetaCloudWhatsAppProvider` implementaria a mesma interface sem
 * exigir mudança em `WhatsappService` nem no controller.
 */
export interface WhatsappProvider {
  obterStatus(): Promise<StatusWhatsapp>;
  conectar(): Promise<StatusWhatsapp>;
  desconectar(): Promise<StatusWhatsapp>;
  enviarTexto(input: EnviarTextoWhatsappInput): Promise<EnviarTextoWhatsappResultado>;
}
