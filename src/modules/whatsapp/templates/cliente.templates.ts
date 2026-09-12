/**
 * Mensagem padrão para Cliente — espelha `TEMPLATES_WHATSAPP.geral` do
 * Backoffice (`mariela-backoffice/src/services/whatsapp/messages.ts`), usada
 * apenas quando a requisição não informa `mensagem` (o Backoffice hoje sempre
 * envia uma mensagem já composta/editável pelo administrador; este template
 * é o valor de referência/fallback, não uma substituição da composição
 * existente — Etapa Pré-22, §20).
 */
export function templatePadraoCliente(nome: string): string {
  return `Olá, ${primeiroNome(nome)}! 💜
Passando para desejar um ótimo dia!
Estamos com novidades na MARIELA e será um prazer receber você em nossa loja.`;
}

export function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? nome.trim();
}
