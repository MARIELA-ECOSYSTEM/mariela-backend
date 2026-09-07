/**
 * Papéis administrativos do Backoffice. Vendedores (MARIELA PDV) NÃO são um
 * papel aqui — são uma entidade de domínio comercial totalmente separada da
 * identidade/autorização do sistema, e nunca terão acesso a estas rotas.
 *
 * Hoje só existe ADMIN; a lista existe em array (não apenas o tipo) para o
 * `RolesGuard`/schema validarem contra um conjunto conhecido, e para novos
 * papéis administrativos serem adicionados aqui no futuro sem tocar em guards.
 */
export const ROLES = ["ADMIN"] as const;
export type Role = (typeof ROLES)[number];
