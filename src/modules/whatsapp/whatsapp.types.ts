/** Quem o botão de WhatsApp do Backoffice está tentando alcançar — resolvido pelo backend, nunca informado como telefone cru pelo frontend. */
export type TipoDestinatarioWhatsapp = "CLIENTE" | "FORNECEDOR" | "VENDEDOR";

export const TIPOS_DESTINATARIO_WHATSAPP: TipoDestinatarioWhatsapp[] = ["CLIENTE", "FORNECEDOR", "VENDEDOR"];

/**
 * Estado de conexão da instância, já normalizado pelo MARIELA — nunca o
 * vocabulário bruto da Evolution API (`open`/`close`/`connecting`) vaza para
 * o frontend.
 */
export type StatusConexaoWhatsapp = "CONNECTED" | "CONNECTING" | "QRCODE" | "DISCONNECTED" | "NOT_CONFIGURED" | "ERROR";

/** Resposta pública de `GET /integracoes/whatsapp/status` (e do retorno de conectar/desconectar). */
export interface StatusWhatsapp {
  provider: "evolution-api";
  transporte: "baileys";
  instance: string;
  status: StatusConexaoWhatsapp;
  /** Número oficial da loja (E.164) — vem da configuração do servidor, nunca do frontend. `null` quando não configurado. */
  numero: string | null;
  /** Presente somente quando `status === "QRCODE"`. Nunca persistido em MongoDB. */
  qrCode: string | null;
}

/** Resposta pública de `POST /integracoes/whatsapp/mensagens`. */
export interface ResultadoEnvioWhatsapp {
  id: string;
  status: "enviada";
  tipo: TipoDestinatarioWhatsapp;
  /** Telefone normalizado (E.164) para o qual a mensagem foi enviada — confirmação, não segredo. */
  destinatario: string;
}
