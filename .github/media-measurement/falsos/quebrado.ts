// Fase 60.4.3.4.4 — subprocesso de validação que falha (erro interno do validador, código 3). Só medição.
process.stderr.write("falha simulada do validador\n");
process.exit(3);
