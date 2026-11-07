// Fase 60.4.3.4.1 — subprocesso de validação que falha (simula crash do decodificador). Só para testes.
process.stderr.write("falha simulada do decodificador\n");
process.exit(3);
