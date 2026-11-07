// Fase 60.4.3.4.4 — subprocesso de validação que nunca responde (exercita o prazo real de 10 s). Só medição.
setInterval(() => undefined, 1_000);
