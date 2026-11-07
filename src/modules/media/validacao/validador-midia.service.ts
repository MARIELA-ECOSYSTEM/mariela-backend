import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ApiException } from "../../../common/exceptions/api.exception.js";
import { CONCORRENCIA_VALIDACAO_MIDIA, PRAZO_VALIDACAO_MIDIA_MS } from "./validacao-midia.constants.js";
import { ehResultadoValidacao, type ResultadoValidacao } from "./validacao-midia.types.js";

export interface OpcoesValidadorMidia {
  /** Prazo TOTAL (fila + subprocesso). */
  prazoMs: number;
  /** Validações simultâneas nesta instância. */
  concorrencia: number;
  /** Script executado no subprocesso; `null` = `validador-midia.processo` ao lado deste arquivo. Só os testes trocam. */
  script: string | null;
}

/** Token opcional para os testes ajustarem prazo, concorrência ou o script do subprocesso. */
export const OPCOES_VALIDADOR_MIDIA = Symbol("OPCOES_VALIDADOR_MIDIA");

/** Variáveis repassadas ao subprocesso: NENHUM segredo (banco, JWT, R2) chega a ele. */
const AMBIENTE_PERMITIDO = ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "LANG", "TZ"];

function ambienteMinimo(): Record<string, string> {
  const ambiente: Record<string, string> = {};
  for (const nome of AMBIENTE_PERMITIDO) {
    const valor = process.env[nome];
    if (valor !== undefined) ambiente[nome] = valor;
  }
  return ambiente;
}

/** `dist/` (build) tem o `.js`; nos testes e no `start:dev` o Bun executa o `.ts` direto de `src/`. */
function scriptPadrao(): string {
  for (const extensao of [".js", ".ts"]) {
    const caminho = fileURLToPath(new URL(`./validador-midia.processo${extensao}`, import.meta.url));
    if (existsSync(caminho)) return caminho;
  }
  throw new Error("Script do validador de mídia não encontrado.");
}

/** Semáforo com espera limitada: `adquirir` devolve `false` se o prazo vencer na fila. */
class Semaforo {
  private ativos = 0;
  private readonly fila: { conceder: () => void }[] = [];

  constructor(private readonly limite: number) {}

  get emUso(): number {
    return this.ativos;
  }

  adquirir(prazoMs: number): Promise<boolean> {
    if (this.ativos < this.limite) {
      this.ativos += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolver) => {
      const espera = {
        conceder: () => {
          clearTimeout(temporizador);
          resolver(true);
        },
      };
      const temporizador = setTimeout(() => {
        const indice = this.fila.indexOf(espera);
        if (indice >= 0) this.fila.splice(indice, 1);
        resolver(false);
      }, Math.max(0, prazoMs));
      this.fila.push(espera);
    });
  }

  /** Passa a vaga direto ao próximo da fila (sem decrementar) ou a devolve. */
  liberar(): void {
    const proxima = this.fila.shift();
    if (proxima) proxima.conceder();
    else this.ativos -= 1;
  }
}

/**
 * Fase 60.4.3.4.1 — executa a validação de conteúdo (`validarConteudoDeMidia`) num SUBPROCESSO Bun isolado:
 * - a decodificação nativa e o parser não disputam a thread da API; um crash ou travamento do decodificador não a derruba;
 * - prazo rígido (`PRAZO_VALIDACAO_MIDIA_MS`, fila incluída): vencido, o subprocesso é encerrado (`kill`) — a única forma
 *   de interromper código nativo;
 * - no máximo `CONCORRENCIA_VALIDACAO_MIDIA` validações simultâneas por instância (limita o pico de memória);
 * - sem arquivos temporários: os bytes vão pelo stdin e o veredito volta pelo stdout. A memória do subprocesso é
 *   devolvida ao sistema quando ele termina, em sucesso, erro ou prazo.
 *
 * Arquivo inválido NÃO é exceção aqui: volta como `{ valido: false }`. Prazo, fila cheia, falha ao iniciar, saída ≠ 0
 * ou resposta ilegível viram `MEDIA_VALIDATION_UNAVAILABLE` (503) — nunca "arquivo válido".
 */
@Injectable()
export class ValidadorMidiaService {
  private readonly logger = new Logger(ValidadorMidiaService.name);
  private readonly opcoes: OpcoesValidadorMidia;
  private readonly semaforo: Semaforo;

  constructor(@Optional() @Inject(OPCOES_VALIDADOR_MIDIA) opcoes?: Partial<OpcoesValidadorMidia>) {
    this.opcoes = { prazoMs: PRAZO_VALIDACAO_MIDIA_MS, concorrencia: CONCORRENCIA_VALIDACAO_MIDIA, script: null, ...opcoes };
    this.semaforo = new Semaforo(this.opcoes.concorrencia);
  }

  /** Validações em execução agora (para os testes de concorrência). */
  get emExecucao(): number {
    return this.semaforo.emUso;
  }

  async validar(contentType: string, bytes: Uint8Array): Promise<ResultadoValidacao> {
    const inicio = Date.now();
    if (!(await this.semaforo.adquirir(this.opcoes.prazoMs))) throw this.indisponivel("prazo esgotado na fila de validação");
    try {
      return await this.executar(contentType, bytes, this.opcoes.prazoMs - (Date.now() - inicio));
    } finally {
      this.semaforo.liberar();
    }
  }

  private async executar(contentType: string, bytes: Uint8Array, prazoRestanteMs: number): Promise<ResultadoValidacao> {
    if (prazoRestanteMs <= 0) throw this.indisponivel("prazo esgotado antes de iniciar");
    let processo: Bun.Subprocess<Uint8Array, "pipe", "pipe">;
    try {
      processo = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", this.opcoes.script ?? scriptPadrao(), contentType],
        stdin: bytes,
        stdout: "pipe",
        stderr: "pipe",
        env: ambienteMinimo(),
      });
    } catch (erro) {
      throw this.indisponivel(`falha ao iniciar o subprocesso (${erro instanceof Error ? erro.name : typeof erro})`);
    }

    let prazoVencido = false;
    const temporizador = setTimeout(() => {
      prazoVencido = true;
      processo.kill("SIGKILL");
    }, prazoRestanteMs);
    try {
      const [saida, erros, codigo] = await Promise.all([new Response(processo.stdout).text(), new Response(processo.stderr).text(), processo.exited]);
      if (prazoVencido) throw this.indisponivel(`prazo de ${this.opcoes.prazoMs} ms esgotado (subprocesso encerrado)`);
      if (codigo !== 0) throw this.indisponivel(`subprocesso terminou com código ${codigo}${erros ? `: ${erros.trim().slice(0, 200)}` : ""}`);
      let resultado: unknown;
      try {
        resultado = JSON.parse(saida);
      } catch {
        throw this.indisponivel("resposta do subprocesso não é JSON");
      }
      if (!ehResultadoValidacao(resultado)) throw this.indisponivel("resposta do subprocesso fora do contrato");
      return resultado;
    } finally {
      clearTimeout(temporizador);
      if (processo.exitCode === null && !processo.killed) processo.kill("SIGKILL");
    }
  }

  private indisponivel(motivo: string): ApiException {
    this.logger.warn(`Validador de mídia indisponível: ${motivo}.`);
    return ApiException.mediaValidationUnavailable();
  }
}
