import type { LoggerService, LogLevel } from "@nestjs/common";

interface LinhaDeLog {
  timestamp: string;
  level: LogLevel;
  context: string;
  message: string;
  trace?: string;
}

const CONTEXTO_PADRAO = "Application";

/**
 * Logger estruturado (uma linha JSON por evento) para stdout — trivial de
 * agregar por qualquer coletor de logs (Docker, systemd, um serviço gerenciado)
 * sem precisar de parsing de texto livre.
 *
 * NUNCA repassar aqui senhas, tokens, segredos ou corpos de requisição
 * completos — apenas mensagens já resumidas pelo chamador.
 */
export class StructuredLoggerService implements LoggerService {
  log(message: string, context: string = CONTEXTO_PADRAO): void {
    this.emitir("log", message, context);
  }

  error(message: string, trace?: string, context: string = CONTEXTO_PADRAO): void {
    this.emitir("error", message, context, trace);
  }

  warn(message: string, context: string = CONTEXTO_PADRAO): void {
    this.emitir("warn", message, context);
  }

  debug(message: string, context: string = CONTEXTO_PADRAO): void {
    this.emitir("debug", message, context);
  }

  verbose(message: string, context: string = CONTEXTO_PADRAO): void {
    this.emitir("verbose", message, context);
  }

  private emitir(level: LogLevel, message: string, context: string, trace?: string): void {
    const linha: LinhaDeLog = {
      timestamp: new Date().toISOString(),
      level,
      context,
      message,
      ...(trace ? { trace } : {}),
    };
    const destino = level === "error" ? console.error : console.log;
    destino(JSON.stringify(linha));
  }
}
