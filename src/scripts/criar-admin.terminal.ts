/**
 * Entrada interativa do comando `admin:criar`. A leitura é feita em modo raw (tecla a tecla), para que a senha NUNCA
 * seja ecoada no terminal; o mesmo leitor serve às perguntas visíveis (com eco). Ctrl+C (ou Ctrl+D com a linha vazia)
 * cancela em qualquer pergunta. Nada é gravado em arquivo, variável de ambiente ou histórico.
 */

/** Perguntas do comando. `null` = o operador cancelou. */
export interface TerminalInterativo {
  /** `true` só quando entrada E saída são um terminal (nunca um arquivo ou pipe). */
  readonly interativo: boolean;
  perguntar(texto: string): Promise<string | null>;
  /** Não ecoa nada do que é digitado (nem asteriscos). */
  perguntarOculto(texto: string): Promise<string | null>;
}

export interface EstadoLinha {
  valor: string;
  fim: "enviar" | "cancelar" | null;
}

/** Limite de caracteres numa linha: muito acima de qualquer campo válido (a validação de cada campo vem depois). */
export const MAXIMO_CARACTERES_LINHA = 1_000;

/**
 * Função pura: aplica um bloco de teclas (um `data` do stdin em modo raw, que pode conter várias teclas — ex.: colar)
 * à linha em edição. Devolve o novo estado e o que deve ser ecoado (sempre `""` quando `oculto`).
 */
export function aplicarTeclas(estado: EstadoLinha, bloco: string, oculto: boolean): { estado: EstadoLinha; eco: string } {
  if (estado.fim) return { estado, eco: "" };
  // Sequências de escape (setas, Home, F1...) são ignoradas por inteiro.
  if (bloco.startsWith("\u001b")) return { estado, eco: "" };
  let valor = estado.valor;
  let eco = "";
  for (const tecla of bloco) {
    if (tecla === "\u0003") return { estado: { valor: "", fim: "cancelar" }, eco: "" }; // Ctrl+C
    if (tecla === "\u0004" && valor === "") return { estado: { valor: "", fim: "cancelar" }, eco: "" }; // Ctrl+D
    if (tecla === "\r" || tecla === "\n") return { estado: { valor, fim: "enviar" }, eco };
    if (tecla === "\u007f" || tecla === "\b") {
      if (valor.length > 0) {
        valor = Array.from(valor).slice(0, -1).join("");
        if (!oculto) eco += "\b \b";
      }
      continue;
    }
    if (tecla < " ") continue; // demais teclas de controle
    if (valor.length >= MAXIMO_CARACTERES_LINHA) continue;
    valor += tecla;
    if (!oculto) eco += tecla;
  }
  return { estado: { valor, fim: null }, eco };
}

interface EntradaRaw {
  isTTY?: boolean;
  setRawMode?(ativo: boolean): unknown;
  setEncoding(codificacao: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(evento: "data", ouvinte: (bloco: string) => void): unknown;
  off(evento: "data", ouvinte: (bloco: string) => void): unknown;
}

interface SaidaTerminal {
  isTTY?: boolean;
  write(texto: string): unknown;
}

/** Terminal real (stdin/stdout do processo). */
export function criarTerminalDoProcesso(entrada: EntradaRaw = process.stdin, saida: SaidaTerminal = process.stdout): TerminalInterativo {
  const ler = (texto: string, oculto: boolean): Promise<string | null> =>
    new Promise((resolver) => {
      let estado: EstadoLinha = { valor: "", fim: null };
      saida.write(texto);
      entrada.setEncoding("utf8");
      entrada.setRawMode?.(true);
      const aoReceber = (bloco: string) => {
        const passo = aplicarTeclas(estado, bloco, oculto);
        estado = passo.estado;
        if (passo.eco) saida.write(passo.eco);
        if (!estado.fim) return;
        entrada.off("data", aoReceber);
        entrada.setRawMode?.(false);
        entrada.pause();
        saida.write(estado.fim === "cancelar" ? " (cancelado)\n" : "\n");
        resolver(estado.fim === "cancelar" ? null : estado.valor);
      };
      entrada.on("data", aoReceber);
      entrada.resume();
    });
  return {
    interativo: entrada.isTTY === true && saida.isTTY === true && typeof entrada.setRawMode === "function",
    perguntar: (texto) => ler(texto, false),
    perguntarOculto: (texto) => ler(texto, true),
  };
}
