/**
 * Fases 56.2/56.3 — barreiras determinísticas para testes de concorrência.
 *
 * `Barreira`: promise controlada (deferred) — `promessa` só resolve quando
 * `liberar()` é chamado (idempotente). Sem `setTimeout`.
 *
 * `PontoDeParada`: par de barreiras usado por spies que pausam um método real
 * — `chegou` é liberada pela operação ao alcançar o ponto; ela só prossegue
 * depois que o teste libera `liberacao`. Os testes sempre chamam
 * `liberarTudo` em `finally`, para nunca deixar uma operação pendurada.
 */
export class Barreira {
  private resolver: (() => void) | null = null;
  readonly promessa = new Promise<void>((resolver) => {
    this.resolver = resolver;
  });

  liberar(): void {
    this.resolver?.();
  }
}

export type PontoDeParada = { chegou: Barreira; liberacao: Barreira };

export function novoPonto(): PontoDeParada {
  return { chegou: new Barreira(), liberacao: new Barreira() };
}

export function liberarTudo(...pontos: PontoDeParada[]): void {
  for (const ponto of pontos) {
    ponto.chegou.liberar();
    ponto.liberacao.liberar();
  }
}
