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

/**
 * Etapa 24 — rate limiting de `POST /integracoes/whatsapp/mensagens` via
 * `@nestjs/throttler` (`WhatsappController`), mais restrito que o piso
 * global (ver `AppModule`) porque cada requisição aqui pode acionar uma
 * chamada de rede para a Evolution API (custo/estabilidade da sessão de
 * WhatsApp da loja, não só carga do próprio backend). 10 requisições / 10s
 * por IP: cobre um envio manual em lote razoável (a tela ainda não tem um
 * endpoint de "enviar em massa" — cada envio é uma chamada) sem deixar um
 * loop/bug do frontend disparar chamadas ilimitadas contra um provedor
 * externo pago. Valor fixo (não configurável por ambiente), mesmo racional
 * de `AUTH_LOGIN_THROTTLE_LIMITE` — primeira estimativa razoável sem dados
 * reais de uso; revisar se o volume legítimo observado em produção precisar
 * de mais.
 */
export const WHATSAPP_SEND_THROTTLE_LIMITE = 10;
export const WHATSAPP_SEND_THROTTLE_TTL_MS = 10_000;
