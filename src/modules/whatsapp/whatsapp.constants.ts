/** Token de injeção da abstração de provider — permite trocar `EvolutionApiProvider` por outro fornecedor futuro sem tocar `WhatsappService` (Etapa Pré-22, §19). */
export const WHATSAPP_PROVIDER = Symbol("WHATSAPP_PROVIDER");

/**
 * Mesma regra de validade de telefone já usada por Clientes/Fornecedores/
 * Vendedores (DDD + número, 10 ou 11 dígitos) — cada módulo desses já mantém
 * sua própria cópia deste literal (ver `*.constants.ts`); replicado aqui pelo
 * mesmo motivo: nenhum dos três módulos deveria depender do módulo WhatsApp
 * nem vice-versa.
 */
export const TELEFONE_DIGITOS_VALIDOS = [10, 11];
