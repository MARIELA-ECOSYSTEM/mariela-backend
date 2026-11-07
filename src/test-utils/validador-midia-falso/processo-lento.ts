// Fase 60.4.3.4.1 — subprocesso de validação lento (400 ms) que aprova: mede fila e concorrência. Só para testes.
await Bun.sleep(400);
process.stdout.write(`${JSON.stringify({ valido: true, formato: "jpeg", largura: 1, altura: 1 })}\n`);
process.exit(0);
