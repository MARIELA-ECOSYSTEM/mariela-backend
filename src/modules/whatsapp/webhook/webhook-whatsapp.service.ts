import { Inject, Injectable, Logger } from "@nestjs/common";
import { BloqueiosWhatsappService } from "../bloqueios/bloqueios-whatsapp.service.js";
import type { CodigoErroEnvioWhatsapp } from "../envios/envios-whatsapp.constants.js";
import { aplicarEventoStatus } from "../envios/maquina-estados-whatsapp.js";
import { MensagensWhatsappRepository } from "../envios/mensagens-whatsapp.repository.js";
import { recusaPorCodigo } from "../providers/meta/contrato-meta.js";
import type { MensagemWhatsapp } from "../schemas/mensagem-whatsapp.schema.js";
import { TemplatesWhatsappService } from "../templates/templates-whatsapp.service.js";
import { CONFIG_WEBHOOK_WHATSAPP, type ConfiguracaoWebhookMeta } from "./configuracao-webhook-meta.js";
import type { ContagemWebhookMeta, EventoStatusMeta, NotificacaoWebhookMeta, PedidoOptOutMeta } from "./contrato-webhook-meta.js";
import { interpretarNotificacaoMeta } from "./contrato-webhook-meta.js";
import { criarReconhecedorOptOut, PALAVRAS_CHAVE_OPT_OUT } from "./opt-out-palavras-chave.js";
import { TENTATIVAS_TRANSICAO_STATUS } from "./webhook-meta.constants.js";

export type ResultadoStatusWebhook = "aplicado" | "ignorado" | "anomalia" | "desconhecida";

export interface ResumoWebhookWhatsapp {
  status: Record<ResultadoStatusWebhook, number>;
  bloqueiosCriados: number;
  bloqueiosExistentes: number;
  contagem: ContagemWebhookMeta;
}

/** Concorrência otimista esgotada: o POST responde 500 e a Meta reentrega (o processamento é idempotente). */
export class ConcorrenciaEsgotadaWebhook extends Error {
  constructor() {
    super("Transição de status não aplicada após as tentativas de concorrência.");
    this.name = "ConcorrenciaEsgotadaWebhook";
  }
}

/**
 * Fase 22.8.9.10.5 — processamento dos eventos do webhook (JÁ autenticados e interpretados).
 *
 * - Status: correlação SÓ pelo `wamid`; regra de transição = `aplicarEventoStatus` (máquina existente); escrita
 *   condicional ao estado lido. Repetição e fora de ordem são ignorados pela própria regra; `wamid` desconhecido não
 *   cria nada.
 * - Efeitos de `failed` (bloqueio por opt-out de marketing, descarte do cache de aprovação) são idempotentes e
 *   acontecem ANTES da transição: se o processo cair entre os dois, a reentrega da Meta reaplica tudo sem duplicar.
 * - Opt-out: bloqueio por `wa_id` (`whatsapp_bloqueios`), idempotente pelo índice único de bloqueio ativo.
 * - Nenhuma mensagem é enviada; nenhum cliente/fornecedor/vendedor é criado ou alterado.
 * - Logs só com contagens, ids internos, estados e códigos — nunca número, texto, payload, assinatura ou segredo.
 */
@Injectable()
export class WebhookWhatsappService {
  private readonly logger = new Logger(WebhookWhatsappService.name);
  private readonly reconhecerOptOut: (texto: string) => boolean;
  /** Relógio substituível nos testes. */
  relogio: () => Date = () => new Date();

  constructor(
    @Inject(CONFIG_WEBHOOK_WHATSAPP) private readonly config: ConfiguracaoWebhookMeta | null,
    @Inject(PALAVRAS_CHAVE_OPT_OUT) palavrasChave: readonly string[],
    private readonly mensagens: MensagensWhatsappRepository,
    private readonly bloqueios: BloqueiosWhatsappService,
    private readonly templates: TemplatesWhatsappService,
  ) {
    this.reconhecerOptOut = criarReconhecedorOptOut(palavrasChave);
  }

  /** `null` = webhook desativado (configuração ausente/incompleta). */
  configuracao(): ConfiguracaoWebhookMeta | null {
    return this.config;
  }

  /** Lança `ErroContratoWebhookMeta` se o envelope estiver fora do contrato. */
  interpretar(json: unknown): NotificacaoWebhookMeta {
    if (!this.config) throw new Error("Webhook desativado.");
    return interpretarNotificacaoMeta(json, this.config.phoneNumberId, this.reconhecerOptOut);
  }

  async processar(notificacao: NotificacaoWebhookMeta): Promise<ResumoWebhookWhatsapp> {
    const resumo: ResumoWebhookWhatsapp = {
      status: { aplicado: 0, ignorado: 0, anomalia: 0, desconhecida: 0 },
      bloqueiosCriados: 0,
      bloqueiosExistentes: 0,
      contagem: notificacao.contagem,
    };
    for (const evento of notificacao.statuses) resumo.status[await this.aplicarStatus(evento)] += 1;
    for (const pedido of notificacao.optOuts) {
      const { criado } = await this.registrarOptOut(pedido);
      if (criado) resumo.bloqueiosCriados += 1;
      else resumo.bloqueiosExistentes += 1;
    }
    this.logger.log(JSON.stringify({ evento: "whatsapp.webhook.processado", ...resumo }));
    return resumo;
  }

  private async aplicarStatus(evento: EventoStatusMeta): Promise<ResultadoStatusWebhook> {
    for (let tentativa = 0; tentativa < TENTATIVAS_TRANSICAO_STATUS; tentativa++) {
      const mensagem = await this.mensagens.encontrarPorWamid(evento.wamid);
      if (!mensagem) return "desconhecida";

      const decisao = aplicarEventoStatus(mensagem.estado, evento.status);
      if (decisao.tipo === "ignorado") return "ignorado";
      if (decisao.tipo === "anomalia") {
        this.logger.warn(
          JSON.stringify({ evento: "whatsapp.webhook.status_anomalo", mensagemId: String(mensagem._id), estado: mensagem.estado, status: evento.status, codigoErro: evento.codigoErro }),
        );
        return "anomalia";
      }

      const agora = this.relogio();
      const quando = evento.ocorridoEm ?? agora;
      const campos: Partial<Pick<MensagemWhatsapp, "aceitaEm" | "entregueEm" | "lidaEm" | "falhaEm" | "erroCodigo" | "erroCodigoProvedor">> = {};
      switch (decisao.para) {
        case "aceita":
          campos.aceitaEm = mensagem.aceitaEm ?? quando;
          break;
        case "entregue":
          campos.entregueEm = quando;
          break;
        case "lida":
          // `read` implica `delivered` (pode chegar sem `delivered`, documentado pela Meta).
          campos.lidaEm = quando;
          campos.entregueEm = mensagem.entregueEm ?? quando;
          break;
        case "falha": {
          const codigo: CodigoErroEnvioWhatsapp = evento.codigoErro !== null ? recusaPorCodigo(evento.codigoErro) : "RECUSADA";
          campos.falhaEm = quando;
          campos.erroCodigo = codigo;
          campos.erroCodigoProvedor = evento.codigoErro !== null ? String(evento.codigoErro) : null;
          // Efeitos idempotentes ANTES da transição (ver doc da classe).
          if (codigo === "OPT_OUT_MARKETING") {
            await this.bloqueios.bloquearNumero(mensagem.telefoneE164, mensagem.destinatarioId, "META_OPT_OUT", null);
          }
          if (codigo === "TEMPLATE_INVALIDO") this.templates.invalidar(mensagem.templateChave);
          break;
        }
        default:
          return "ignorado";
      }

      if (await this.mensagens.aplicarTransicaoStatus(mensagem._id, evento.wamid, mensagem.estado, decisao.para, campos, agora)) {
        return "aplicado";
      }
      // Outra escrita mudou o estado entre a leitura e a escrita: relê e reavalia (a regra decide de novo).
    }
    throw new ConcorrenciaEsgotadaWebhook();
  }

  private async registrarOptOut(pedido: PedidoOptOutMeta): Promise<{ criado: boolean }> {
    const motivo = pedido.origem === "META_OPT_OUT" ? "Webhook Meta: parar mensagens de marketing." : "Webhook Meta: palavra-chave de opt-out.";
    const { criado } = await this.bloqueios.bloquearWaId(pedido.waId, pedido.origem, motivo);
    return { criado };
  }
}
