import { Controller, Get, Logger, Post, Req, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { ERROR_CODES } from "../../../common/constants/error-codes.constant.js";
import { assinaturaWebhookValida, verificarDesafioGet } from "./assinatura-webhook-meta.js";
import { ErroContratoWebhookMeta } from "./contrato-webhook-meta.js";
import { CAMINHO_WEBHOOK_WHATSAPP, HEADER_ASSINATURA_META } from "./webhook-meta.constants.js";
import { WebhookWhatsappService } from "./webhook-whatsapp.service.js";

type CodigoErro = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Fase 22.8.9.10.5 — webhook da WhatsApp Cloud API. Rota PÚBLICA (a Meta não envia JWT): a autenticação é o
 * `hub.verify_token` no GET e a assinatura HMAC-SHA256 (`X-Hub-Signature-256`, App Secret) no POST, validada sobre os
 * BYTES ORIGINAIS (parser bruto só nesta rota — `registrarCorpoBrutoWebhookWhatsapp`). O throttle global continua.
 *
 * Respostas escritas aqui mesmo (`@Res`), sempre com mensagem genérica: nada do payload, do token, do segredo ou de
 * erro interno volta ao remetente. Sucesso (200) só depois de TODA a persistência; falha interna → 500 e a Meta
 * reentrega (o processamento é idempotente).
 */
@ApiExcludeController()
@Controller(CAMINHO_WEBHOOK_WHATSAPP)
export class WebhookWhatsappController {
  private readonly logger = new Logger(WebhookWhatsappController.name);

  constructor(private readonly service: WebhookWhatsappService) {}

  @Get()
  verificar(@Req() req: Request, @Res() res: Response): void {
    const config = this.service.configuracao();
    const challenge = config ? verificarDesafioGet(req.query as Record<string, unknown>, config.verifyToken) : null;
    if (challenge === null) {
      this.logger.warn(JSON.stringify({ evento: "whatsapp.webhook.verificacao_recusada", configurado: config !== null }));
      responderErro(res, 403, ERROR_CODES.FORBIDDEN, "Verificação recusada.");
      return;
    }
    this.logger.log(JSON.stringify({ evento: "whatsapp.webhook.verificacao_aceita" }));
    res.status(200).type("text/plain").send(challenge);
  }

  @Post()
  async receber(@Req() req: Request, @Res() res: Response): Promise<void> {
    const config = this.service.configuracao();
    if (!config) {
      responderErro(res, 503, ERROR_CODES.WHATSAPP_NOT_CONFIGURED, "Webhook não configurado.");
      return;
    }

    const corpo: unknown = req.body;
    if (!Buffer.isBuffer(corpo)) {
      // Sem bytes originais (parser bruto ausente ou requisição sem corpo): NUNCA validar sobre corpo reserializado.
      const semCorpo = corpo === undefined || (typeof corpo === "object" && corpo !== null && Object.keys(corpo).length === 0);
      if (!semCorpo) this.logger.error(JSON.stringify({ evento: "whatsapp.webhook.corpo_bruto_indisponivel" }));
      responderErro(res, semCorpo ? 400 : 500, semCorpo ? ERROR_CODES.VALIDATION_ERROR : ERROR_CODES.INTERNAL_ERROR, "Corpo inválido.");
      return;
    }
    if (corpo.length === 0) {
      responderErro(res, 400, ERROR_CODES.VALIDATION_ERROR, "Corpo inválido.");
      return;
    }

    // 1) Autenticidade ANTES de qualquer leitura do conteúdo.
    if (!assinaturaWebhookValida(corpo, req.headers[HEADER_ASSINATURA_META], config.appSecret)) {
      this.logger.warn(JSON.stringify({ evento: "whatsapp.webhook.assinatura_invalida", presente: req.headers[HEADER_ASSINATURA_META] !== undefined }));
      responderErro(res, 401, ERROR_CODES.UNAUTHORIZED, "Assinatura inválida.");
      return;
    }

    // 2) Contrato: JSON, envelope documentado.
    if (!req.is("application/json")) {
      responderErro(res, 415, ERROR_CODES.HTTP_ERROR, "Tipo de conteúdo não suportado.");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(corpo.toString("utf8"));
    } catch {
      this.logger.warn(JSON.stringify({ evento: "whatsapp.webhook.json_invalido" }));
      responderErro(res, 400, ERROR_CODES.VALIDATION_ERROR, "Corpo inválido.");
      return;
    }

    try {
      const notificacao = this.service.interpretar(json);
      await this.service.processar(notificacao);
      res.status(200).json({ recebido: true });
    } catch (erro) {
      if (erro instanceof ErroContratoWebhookMeta) {
        this.logger.warn(JSON.stringify({ evento: "whatsapp.webhook.contrato_invalido" }));
        responderErro(res, 400, ERROR_CODES.VALIDATION_ERROR, "Notificação inválida.");
        return;
      }
      // Só o NOME do erro: a mensagem pode carregar dados (ex.: erro do driver com o filtro usado).
      this.logger.error(JSON.stringify({ evento: "whatsapp.webhook.falha_processamento", erro: erro instanceof Error ? erro.name : "desconhecido" }));
      responderErro(res, 500, ERROR_CODES.INTERNAL_ERROR, "Falha ao processar a notificação.");
    }
  }
}

function responderErro(res: Response, statusCode: number, code: CodigoErro, message: string): void {
  res.status(statusCode).json({ statusCode, code, message });
}
