/**
 * Fase 22.8.9.10.3 — máscara de telefone para RESPOSTAS da API (nunca o número completo). Logs não recebem nem a
 * versão mascarada: registram só ids e estados.
 *
 * `+5511987654321` → `+55 11 9****-4321`; `+551132654321` → `+55 11 ****-4321`. Formato inesperado: só os 4
 * últimos dígitos (`****4321`) — nunca devolve o valor de entrada.
 */
export function mascararTelefone(e164: string | null | undefined): string {
  const digitos = (e164 ?? "").replace(/\D/g, "");
  const brasil = /^55(\d{2})(\d{8,9})$/.exec(digitos);
  if (brasil) {
    const [, ddd, numero] = brasil as unknown as [string, string, string];
    const final = numero.slice(-4);
    return numero.length === 9 ? `+55 ${ddd} ${numero[0]}****-${final}` : `+55 ${ddd} ****-${final}`;
  }
  return digitos.length >= 4 ? `****${digitos.slice(-4)}` : "****";
}
