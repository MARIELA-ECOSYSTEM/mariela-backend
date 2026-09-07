/**
 * Paginação PRÓPRIA do catálogo do PDV — deliberadamente diferente da
 * administrativa (`produtos.constants.ts`: página=1/limite=20/máximo=100).
 * O PDV é consumido por uma grade touch-first (grid de cards), não uma
 * tabela densa — um limite padrão maior (30) reduz o número de buscas ao
 * rolar o catálogo; um máximo menor (60) evita que um cliente mal
 * intencionado peça páginas gigantes só porque o valor está tecnicamente
 * disponível (o volume real de uma boutique não justifica mais que isso).
 */
export const PAGINA_PADRAO_PDV = 1;
export const LIMITE_PADRAO_PDV = 30;
export const LIMITE_MAXIMO_PDV = 60;
