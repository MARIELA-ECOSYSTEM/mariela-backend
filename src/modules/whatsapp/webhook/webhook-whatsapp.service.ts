import { Inject, Injectable, Logger } from "@nestjs/common";
import { BloqueiosWhatsappService } from "../bloqueios/bloqueios-whatsapp.service.js";
import type { CodigoErroEnvioWhatsapp } from "../envios/envios-whatsapp.constants.js";
import { aplicarEventoStatus } from "../envios/maquina-estados-whatsapp.js";
import { MensagensWhatsappRepository } from "../envios/mensagens-whatsapp.repository.js";
import { inicioDaJanela, mensagemAindaAbreJanela } from "../janela/janela-atendimento.js";
import { JanelasWhatsappRepository, type ResultadoRegistroJanela } from "../janela/janelas-whatsapp.repository.js";
import { recusaPorCodigo } from "../providers/meta/contrato-meta.js";
import type { MensagemWhatsapp } from "../schemas/mensagem-whatsapp.schema.js";
import { TemplatesWhatsappService } from "../templates/templates-whatsapp.service.js";
import { CONFIG_WEBHOOK_WHATSAPP, type ConfiguracaoWebhookMeta } from "./configuracao-webhook-meta.js";
import type {
  ContagemWebhookMeta,
  EventoStatusMeta,
  MensagemRecebidaMeta,
  NotificacaoWebhookMeta,
  PedidoOptOutMeta,
} from "./contrato-webhook-meta.js";
import { interpretarNotificacaoMeta } from "./contrato-webhook-meta.js";
import { TENTATIVAS_TRANSICAO_STATUS } from "./webhook-meta.constants.js";

export type ResultadoStatusWebhook = "aplicado" | "ignorado" | "anomalia" | "desconhecida";

/** `antiga` = a mensagem já não abriria a janela agora (nada é gravado). */
export type ResultadoJanelaWebhook = ResultadoRegistroJanela | "antiga";

export interface ResumoWebhookWhatsapp {
  status: Record<ResultadoStatusWebhook, number>;
  bloqueiosCriados: number;
  bloqueiosExistentes: number;
  /** Fase 22.8.9.10.7.4 — contagens da janela de atendimento (nunca o número nem o conteúdo). */
  janelas: Record<ResultadoJanelaWebhook, number>;
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
 * - Opt-out: só o OFICIAL da Meta (`user_preferences` → `stop`), bloqueio por `wa_id` (`whatsapp_bloqueios`),
 *   idempotente pelo índice único de bloqueio ativo. O conteúdo de mensagens recebidas nunca é lido (Fase 22.8.9.10.7.2:
 *   o reconhecimento de palavras-chave foi removido).
 * - Fase 22.8.9.10.7.4: mensagem recebida válida só registra a janela de atendimento de 24 h (`whatsapp_janelas`).
 * - Nenhuma mensagem é enviada; nenhum cliente/fornecedor/vendedor é criado ou alterado.
 * - Logs só com contagens, ids internos, estados e códigos — nunca número, texto, payload, assinatura ou segredo.
 */
@Injectable()
export class WebhookWhatsappService {
  private readonly logger = new Logger(WebhookWhatsappService.name);
  /** Relógio substituível nos testes. */
  relogio: () => Date = () => new Date();

  constructor(
    @Inject(CONFIG_WEBHOOK_WHATSAPP) private readonly config: ConfiguracaoWebhookMeta | null,
    private readonly mensagens: MensagensWhatsappRepository,
    private readonly bloqueios: BloqueiosWhatsappService,
    private readonly templates: TemplatesWhatsappService,
    private readonly janelas: JanelasWhatsappRepository,
  ) {}

  /** `null` = webhook desativado (configuração ausente/incompleta). */
  configuracao(): ConfiguracaoWebhookMeta | null {
    return this.config;
  }

  /** Lança `ErroContratoWebhookMeta` se o envelope estiver fora do contrato. */
  interpretar(json: unknown): NotificacaoWebhookMeta {
    if (!this.config) throw new Error("Webhook desativado.");
    return interpretarNotificacaoMeta(json, this.config.phoneNumberId);
  }

  async processar(notificacao: NotificacaoWebhookMeta): Promise<ResumoWebhookWhatsapp> {
    const resumo: ResumoWebhookWhatsapp = {
      status: { aplicado: 0, ignorado: 0, anomalia: 0, desconhecida: 0 },
      bloqueiosCriados: 0,
      bloqueiosExistentes: 0,
      janelas: { criada: 0, estendida: 0, inalterada: 0, antiga: 0 },
      contagem: notificacao.contagem,
    };
    for (const evento of notificacao.statuses) resumo.status[await this.aplicarStatus(evento)] += 1;
    for (const pedido of notificacao.optOuts) {
      const { criado } = await this.registrarOptOut(pedido);
      if (criado) resumo.bloqueiosCriados += 1;
      else resumo.bloqueiosExistentes += 1;
    }
    for (const mensagem of notificacao.mensagensRecebidas) resumo.janelas[await this.registrarJanela(mensagem)] += 1;
    this.logger.log(JSON.stringify({ evento: "whatsapp.webhook.processado", ...resumo }));
    return resumo;
  }

  /**
   * Fase 22.8.9.10.7.4 — janela de atendimento: guarda o instante da mensagem (limitado ao relógio do backend) para o
   * `wa_id` do contato, só se ela ainda pode abrir a janela. Reentrega/fora de ordem não estendem nada (`$max`).
   */
  private async registrarJanela(mensagem: MensagemRecebidaMeta): Promise<ResultadoJanelaWebhook> {
    if (!this.config) return "antiga"; // inalcançável: sem configuração o POST nem chega aqui
    const agora = this.relogio();
    const inicio = inicioDaJanela(mensagem.enviadaEm, agora);
    if (!mensagemAindaAbreJanela(inicio, agora)) return "antiga";
    return this.janelas.registrar(this.config.phoneNumberId, mensagem.waId, inicio, agora);
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
          if (codigo === "TEMPLATE_INVALIDO" && mensagem.templateChave) this.templates.invalidar(mensagem.templateChave);
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
    const { criado } = await this.bloqueios.bloquearWaId(pedido.waId, pedido.origem, "Webhook Meta: parar mensagens de marketing.");
    return { criado };
  }
}
