// Fase 60.4.3.4.3 — subprocesso de validação falso cujo comportamento é escolhido pelo MIME (argv[2]), para que UMA
// mesma instância do validador (com a mesma fila) alterne entre sucesso, recusa, erro e travamento. Só para testes.
//   teste/travar  → nunca responde (o pai encerra no prazo)
//   teste/quebrar → sai com código 3
//   teste/carimbo → 200 ms de trabalho; recusa com o detalhe "<inicio>-<fim>" (Date.now() do PRÓPRIO subprocesso)
//   qualquer outro → 200 ms de trabalho; aprova
const tipo = process.argv[2] ?? "";
if (tipo === "teste/travar") {
  setInterval(() => undefined, 1_000);
} else if (tipo === "teste/quebrar") {
  process.exit(3);
} else {
  const inicio = Date.now();
  await Bun.sleep(200);
  const resultado =
    tipo === "teste/carimbo" ? { valido: false, motivo: "estrutura", detalhe: `${inicio}-${Date.now()}` } : { valido: true, formato: "jpeg", largura: 1, altura: 1 };
  process.stdout.write(`${JSON.stringify(resultado)}\n`);
  process.exit(0);
}
