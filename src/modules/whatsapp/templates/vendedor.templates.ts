import { primeiroNome } from "./cliente.templates.js";

/** Espelha `TEMPLATES_WHATSAPP.vendedor` do Backoffice — ver `cliente.templates.ts` para o racional de quando este fallback é usado. */
export function templatePadraoVendedor(nome: string): string {
  return `Olá, ${primeiroNome(nome)}! 💜
Mensagem da administração da MARIELA.
Passando um recado rápido sobre a operação da loja.`;
}
