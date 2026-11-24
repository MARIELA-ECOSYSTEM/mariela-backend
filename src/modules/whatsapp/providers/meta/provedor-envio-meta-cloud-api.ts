import { Logger } from "@nestjs/common";
import type {
  EnviarTemplateWhatsappInput,
  InfoTemplateProvedorWhatsapp,
  ProvedorEnvioWhatsapp,
  ResultadoEnvioProvedorWhatsapp,
} from "../provedor-envio-whatsapp.interface.js";
import type { ClienteHttpMetaWhatsapp } from "./cliente-http-meta.js";
import type { ConfiguracaoMetaValida } from "./configuracao-meta.js";
import { classificarRespostaEnvio, lerConsultaTemplate, montarPayloadTemplate } from "./contrato-meta.js";

/** Formatos aceitos na entrada — defesa em profundidade: o fluxo já entrega tudo resolvido do cadastro e do catálogo. */
const DESTINATARIO_E164 = /^\+[1-9]\d{7,14}$/;
const NOME_TEMPLATE = /^[a-z0-9_]{1,512}$/;
const IDIOMA_TEMPLATE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const TAMANHO_MAXIMO_PARAMETRO = 1024;

/**
 * Fase 22.8.9.10.4 — adaptador OFICIAL da WhatsApp Cloud API (Meta) para `ProvedorEnvioWhatsapp`.
 *
 * - Só é construído por `criarProvedorEnvioWhatsapp` com configuração completa e válida; o padrão continua o
 *   provedor desativado.
 * - Não decide destinatário, bloqueio, catálogo, aprovação nem idempotência: recebe o pedido já resolvido pelo fluxo
 *   (`EnviosWhatsappService`) e faz UMA chamada HTTP por envio, sem retry.
 * - Nunca lança no envio: classifica (`aceita`/`recusada`/`indeterminada`) de forma conservadora.
 * - Logs só com id interno, resultado, códigos e status HTTP — nunca token, número, nome, parâmetros ou corpo.
 */
export class ProvedorEnvioMetaCloudApi implements ProvedorEnvioWhatsapp {
  readonly nome = "meta-cloud-api";
  private readonly logger = new Logger(ProvedorEnvioMetaCloudApi.name);

  constructor(
    private readonly config: ConfiguracaoMetaValida,
    private readonly cliente: ClienteHttpMetaWhatsapp,
    /** Número da própria loja (E.164), se conhecido — nunca é destinatário. */
    private readonly numeroDaLojaE164: string | null,
  ) {}

  configurado(): boolean {
    return true;
  }

  async enviarTemplate(input: EnviarTemplateWhatsappInput): Promise<ResultadoEnvioProvedorWhatsapp> {
    const recusaLocal = this.validarEntrada(input);
    if (recusaLocal) {
      this.registrar(input.referenciaInterna, recusaLocal, null, null, null);
      return recusaLocal;
    }

    const resposta = await this.cliente.requisitar({
      metodo: "POST",
      caminho: `/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`,
      corpo: montarPayloadTemplate(input),
      token: this.config.accessToken,
      timeoutMs: this.config.timeoutMs,
    });
    const { resultado, diagnostico } = classificarRespostaEnvio(resposta);
    this.registrar(input.referenciaInterna, resultado, diagnostico.httpStatus, diagnostico.fbtraceId, diagnostico.statusMensagem);
    return resultado;
  }

  async consultarTemplate(nomeMeta: string, idioma: string): Promise<InfoTemplateProvedorWhatsapp | null> {
    if (!NOME_TEMPLATE.test(nomeMeta) || !IDIOMA_TEMPLATE.test(idioma)) throw new Error("Template com nome ou idioma inválido.");
    const resposta = await this.cliente.requisitar({
      metodo: "GET",
      caminho: `/${this.config.graphApiVersion}/${this.config.businessAccountId}/message_templates`,
      query: { name: nomeMeta },
      token: this.config.accessToken,
      timeoutMs: this.config.timeoutMs,
    });
    return lerConsultaTemplate(resposta, nomeMeta, idioma);
  }

  /** Recusa SEM chamada de rede (comprovadamente não enviada) quando a entrada viola o contrato. */
  private validarEntrada(input: EnviarTemplateWhatsappInput): ResultadoEnvioProvedorWhatsapp | null {
    if (!DESTINATARIO_E164.test(input.telefoneE164)) {
      return { resultado: "recusada", codigo: "RECUSADA", codigoProvedor: "DESTINATARIO_INVALIDO" };
    }
    if (this.numeroDaLojaE164 !== null && input.telefoneE164 === this.numeroDaLojaE164) {
      return { resultado: "recusada", codigo: "RECUSADA", codigoProvedor: "DESTINATARIO_PROPRIA_LOJA" };
    }
    if (
      !NOME_TEMPLATE.test(input.nomeMeta) ||
      !IDIOMA_TEMPLATE.test(input.idioma) ||
      input.parametros.some((p) => typeof p !== "string" || p.trim() === "" || p.length > TAMANHO_MAXIMO_PARAMETRO)
    ) {
      return { resultado: "recusada", codigo: "TEMPLATE_INVALIDO", codigoProvedor: "PARAMETROS_INVALIDOS" };
    }
    return null;
  }

  private registrar(
    referencia: string,
    r: ResultadoEnvioProvedorWhatsapp,
    httpStatus: number | null,
    fbtraceId: string | null,
    statusMensagem: string | null,
  ): void {
    const evento = JSON.stringify({
      evento: "whatsapp.meta.envio",
      mensagemId: referencia,
      resultado: r.resultado,
      codigo: r.resultado === "recusada" ? r.codigo : null,
      codigoProvedor: r.resultado === "aceita" ? null : r.codigoProvedor,
      httpStatus,
      statusMensagem,
      fbtraceId,
    });
    if (r.resultado === "aceita") this.logger.log(evento);
    else this.logger.warn(evento);
  }
}
