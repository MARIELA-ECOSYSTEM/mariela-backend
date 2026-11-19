import { applyDecorators, Injectable, SetMetadata, UseGuards, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { LIMITE_REQUISICOES_UPLOAD, type OperacaoUploadLimitada } from "./media.constants.js";

const METADADO_OPERACAO_UPLOAD = "mariela:limite-upload-midia";
/** Acima disto, cada registro passa a varrer as janelas vencidas (a memória nunca cresce sem limite). */
const ENTRADAS_ANTES_DE_VARRER = 1_000;

export type DecisaoLimiteUpload = { permitido: true } | { permitido: false; retryAfterSegundos: number };

/**
 * Fase 22.8.9.9 — contagem de requisições das operações de upload, por operação e por ADMIN (`sub`), em janela
 * FIXA (a janela começa na primeira requisição e, ao vencer, recomeça do zero). Estado só em memória do processo — o
 * mesmo modelo do throttler global do projeto (`@nestjs/throttler` com o armazenamento padrão), sem Redis nem banco.
 *
 * `registrar` é SÍNCRONO de propósito: conferir e incrementar acontecem sem nenhum `await` entre eles, então
 * requisições simultâneas no mesmo processo são contadas uma a uma e nunca passam juntas pela última vaga.
 * Requisições recusadas não contam. `agora` existe para os testes controlarem o relógio.
 */
@Injectable()
export class LimiteUploadMidiaService {
  agora: () => number = () => Date.now();
  private readonly janelas = new Map<string, { inicio: number; contagem: number }>();

  registrar(operacao: OperacaoUploadLimitada, usuarioId: string): DecisaoLimiteUpload {
    const { limite, janelaMs } = LIMITE_REQUISICOES_UPLOAD[operacao];
    const agora = this.agora();
    if (this.janelas.size > ENTRADAS_ANTES_DE_VARRER) this.varrerVencidas(agora);
    const chave = `${operacao}:${usuarioId}`;
    let janela = this.janelas.get(chave);
    if (!janela || agora - janela.inicio >= janelaMs) {
      janela = { inicio: agora, contagem: 0 };
      this.janelas.set(chave, janela);
    }
    if (janela.contagem >= limite) {
      return { permitido: false, retryAfterSegundos: Math.max(1, Math.ceil((janela.inicio + janelaMs - agora) / 1000)) };
    }
    janela.contagem += 1;
    return { permitido: true };
  }

  /** Só para testes: esquece todas as janelas. */
  reiniciar(): void {
    this.janelas.clear();
  }

  private varrerVencidas(agora: number): void {
    for (const [chave, janela] of this.janelas) {
      const operacao = chave.slice(0, chave.indexOf(":")) as OperacaoUploadLimitada;
      const janelaMs = LIMITE_REQUISICOES_UPLOAD[operacao]?.janelaMs ?? 0;
      if (agora - janela.inicio >= janelaMs) this.janelas.delete(chave);
    }
  }
}

/**
 * Aplica o limite da operação marcada no handler. Roda DEPOIS de `JwtAuthGuard`/`RolesGuard` (guards do método
 * vêm depois dos do controller), então a identidade já foi verificada: o limite é do ADMIN autenticado, não do IP
 * — trocar de rede não renova a cota, e dois administradores atrás do mesmo IP não dividem a mesma cota. Excesso:
 * HTTP 429 no envelope padrão (`TOO_MANY_REQUESTS`) com `Retry-After`; nada da contagem interna é exposto.
 */
@Injectable()
export class LimiteUploadMidiaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limites: LimiteUploadMidiaService,
  ) {}

  canActivate(contexto: ExecutionContext): boolean {
    const operacao = this.reflector.get<OperacaoUploadLimitada | undefined>(METADADO_OPERACAO_UPLOAD, contexto.getHandler());
    if (!operacao) return true;
    const http = contexto.switchToHttp();
    const requisicao = http.getRequest<{ user?: { sub?: unknown } }>();
    const usuarioId = requisicao.user?.sub;
    // Defensivo: sem identidade não há a quem atribuir a cota (os guards de autenticação já teriam recusado).
    if (typeof usuarioId !== "string" || usuarioId.length === 0) throw ApiException.unauthorized("Não autenticado.");
    const decisao = this.limites.registrar(operacao, usuarioId);
    if (decisao.permitido) return true;
    http.getResponse<{ setHeader?: (nome: string, valor: string) => void }>().setHeader?.("Retry-After", String(decisao.retryAfterSegundos));
    throw ApiException.tooManyRequests("Muitas solicitações de envio de mídia em pouco tempo. Aguarde um instante e tente novamente.");
  }
}

/** Marca o handler com a operação limitada e aplica `LimiteUploadMidiaGuard`. */
export function LimitarUploadMidia(operacao: OperacaoUploadLimitada) {
  return applyDecorators(SetMetadata(METADADO_OPERACAO_UPLOAD, operacao), UseGuards(LimiteUploadMidiaGuard));
}
