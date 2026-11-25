import type { CodigoRecusaProvedor } from "../envios/envios-whatsapp.constants.js";

/**
 * Fase 22.8.9.10.3 — contrato do provedor de ENVIO POR TEMPLATE (Cloud API da Meta: `ProvedorEnvioMetaCloudApi`,
 * Fase 22.8.9.10.4; seleção em `criarProvedorEnvioWhatsapp`). Separado de
 * `WhatsappProvider` (Evolution/Baileys, texto livre), que continua intacto durante a transição.
 *
 * O provedor CLASSIFICA o resultado e nunca lança para comunicar uma recusa:
 * - `aceita`: o provedor confirmou o recebimento (id da mensagem obrigatório);
 * - `recusada`: comprovadamente NÃO enviada (recusa explícita do provedor, ou erro de rede ANTES da conexão);
 * - `indeterminada`: pode ter saído (timeout, conexão cortada depois do pedido, 5xx, resposta ilegível).
 * Qualquer exceção lançada pelo provedor é tratada pelo serviço como `indeterminada` (na dúvida, nunca reenviar).
 */
export const PROVEDOR_ENVIO_WHATSAPP = Symbol("PROVEDOR_ENVIO_WHATSAPP");

export interface EnviarTemplateWhatsappInput {
  /** Destinatário em E.164 (`+55DDDNNNNNNNNN`), sempre resolvido do cadastro pelo backend. */
  telefoneE164: string;
  nomeMeta: string;
  idioma: string;
  parametros: readonly string[];
  /** Id interno da mensagem — para correlação no provedor, se ele suportar (a confirmar na Fase 22.8.9.10.4). */
  referenciaInterna: string;
}

/**
 * Fase 22.8.9.10.7.4 — texto livre (`type: "text"`). Só é pedido pelo fluxo depois de confirmar, no backend, a janela
 * de atendimento de 24 h; o provedor não decide janela, bloqueio nem destinatário.
 */
export interface EnviarTextoWhatsappInput {
  /** Destinatário em E.164, sempre resolvido do cadastro pelo backend. */
  telefoneE164: string;
  /** Texto já validado (não vazio, até `LIMITE_TEXTO_LIVRE_WHATSAPP`). */
  texto: string;
  referenciaInterna: string;
}

export type ResultadoEnvioProvedorWhatsapp =
  | { resultado: "aceita"; wamid: string; waId: string | null }
  | { resultado: "recusada"; codigo: CodigoRecusaProvedor; codigoProvedor: string | null }
  | { resultado: "indeterminada"; codigoProvedor: string | null };

/** O que o provedor informa sobre um template cadastrado nele. */
export interface InfoTemplateProvedorWhatsapp {
  nomeMeta: string;
  idioma: string;
  /** Status bruto do provedor (ex.: `APPROVED`, `PENDING`, `REJECTED`, `PAUSED`, `DISABLED`). */
  status: string;
  /** Categoria segundo o provedor (ex.: `MARKETING`, `UTILITY`) — pode diferir do catálogo (reclassificação). */
  categoria: string;
  /** Quantidade de parâmetros do corpo. */
  quantidadeParametros: number;
  /**
   * Fase 22.8.9.10.4 — `false` quando o template exige algo que o envio não fornece (parâmetros nomeados, cabeçalho
   * com variável/mídia, botões com variável). Ausente = compatível (provedores que não informam).
   */
  estruturaCompativel?: boolean;
}

export interface ProvedorEnvioWhatsapp {
  /** Nome para diagnóstico (nunca contém credencial). */
  readonly nome: string;
  /** Configuração completa presente? Falso → as rotas de envio respondem `WHATSAPP_NOT_CONFIGURED`. */
  configurado(): boolean;
  enviarTemplate(input: EnviarTemplateWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp>;
  /** Mesma classificação de `enviarTemplate` (aceita/recusada/indeterminada), uma chamada, sem retry. */
  enviarTexto(input: EnviarTextoWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp>;
  /** `null` = template não existe no provedor. Exceção = não foi possível consultar (aprovação DESCONHECIDA). */
  consultarTemplate(nomeMeta: string, idioma: string): Promise<InfoTemplateProvedorWhatsapp | null>;
}
