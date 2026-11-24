import type { INestApplication } from "@nestjs/common";
import express, { type NextFunction, type Request, type Response } from "express";
import { ERROR_CODES } from "../../../common/constants/error-codes.constant.js";
import { CAMINHO_WEBHOOK_WHATSAPP, LIMITE_CORPO_WEBHOOK } from "./webhook-meta.constants.js";

/** Caminho completo do webhook com o prefixo global (`/api/v1/integracoes/whatsapp/webhook`). */
export function caminhoCompletoWebhookWhatsapp(apiPrefix: string): string {
  return `/${apiPrefix.replace(/^\/+|\/+$/g, "")}/${CAMINHO_WEBHOOK_WHATSAPP}`;
}

/**
 * Fase 22.8.9.10.5 — preserva os BYTES ORIGINAIS do corpo SÓ na rota do webhook (a assinatura HMAC da Meta é sobre
 * eles). Precisa ser registrado ANTES de `app.init()`: o Nest instala os parsers globais (JSON/urlencoded) no `init`,
 * depois deste; como o corpo já foi lido aqui, o body-parser global o PULA (`isFinished`) e `req.body` chega ao
 * controller como `Buffer`. Nenhuma outra rota é afetada (o limite global de JSON continua o padrão).
 *
 * Erros do parser (corpo acima do limite, stream abortado) viram resposta JSON genérica — nunca a página de erro
 * padrão do Express (que inclui stack fora de produção).
 */
export function registrarCorpoBrutoWebhookWhatsapp(app: INestApplication, apiPrefix: string): void {
  const parser = express.raw({ type: () => true, limit: LIMITE_CORPO_WEBHOOK });
  app.use(caminhoCompletoWebhookWhatsapp(apiPrefix), (req: Request, res: Response, next: NextFunction) => {
    parser(req, res, (erro?: unknown) => {
      if (!erro) {
        next();
        return;
      }
      const status = (erro as { status?: unknown }).status === 413 ? 413 : 400;
      res.status(status).json({ statusCode: status, code: status === 413 ? ERROR_CODES.HTTP_ERROR : ERROR_CODES.VALIDATION_ERROR, message: "Corpo inválido." });
    });
  });
}
