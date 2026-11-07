// Fase 60.4.3.4.1 — devolve os NOMES das variáveis de ambiente que o subprocesso recebeu (nunca os valores),
// para o teste provar que nenhum segredo chega a ele. Só para testes.
process.stdout.write(`${JSON.stringify({ valido: false, motivo: "estrutura", detalhe: Object.keys(process.env).sort().join(",") })}\n`);
process.exit(0);
