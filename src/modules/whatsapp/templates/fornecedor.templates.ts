import { primeiroNome } from "./cliente.templates.js";

/** Espelha `TEMPLATES_WHATSAPP.fornecedor` do Backoffice — ver `cliente.templates.ts` para o racional de quando este fallback é usado. */
export function templatePadraoFornecedor(nome: string): string {
  return `Olá, ${primeiroNome(nome)}! 💜
Aqui é a equipe da MARIELA Moda Feminina.
Gostaríamos de alinhar disponibilidade de peças e prazos do próximo pedido.`;
}
