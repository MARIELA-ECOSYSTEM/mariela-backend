/**
 * Normalizações de domínio de Produtos — porta fiel das regras já aprovadas
 * para o frontend (`src/utils/tamanho.ts`, `src/lib/codigos.ts` no repositório
 * do Backoffice), agora como fonte única de verdade no backend.
 */

export const TAMANHO_UNICO = "U";

// Faixa Unicode das marcas diacríticas combinantes, geradas pelo
// `normalize("NFD")` ao decompor letras acentuadas (ex.: "é" → "e" + acento
// combinante). Filtradas por ponto de código numérico — evita depender de um
// caractere combinante literal (ou de um escape `\u`) no código-fonte, o que
// se mostrou frágil ao editar este arquivo neste ambiente.
const INICIO_DIACRITICOS = 0x0300;
const FIM_DIACRITICOS = 0x036f;

function removerDiacriticos(valor: string): string {
  return Array.from(valor)
    .filter((caractere) => {
      const codigo = caractere.codePointAt(0) ?? 0;
      return codigo < INICIO_DIACRITICOS || codigo > FIM_DIACRITICOS;
    })
    .join("");
}

/** Usada SÓ para comparação de unicidade de cor — o valor exibido/salvo em `cor` nunca é alterado. */
export function normalizarCor(cor: string): string {
  return removerDiacriticos(cor.normalize("NFD"))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** "u" → "U"; demais tamanhos apenas normalizados em maiúsculas sem espaços nas pontas. */
export function normalizarTamanho(tamanho: string): string {
  return tamanho.trim().toUpperCase();
}

/**
 * Regra: "U" (tamanho único) não coexiste com nenhum outro tamanho na mesma
 * variante. Devolve a mensagem de erro ou `null` quando a inclusão é válida.
 */
export function conflitoTamanhoUnico(
  tamanhosExistentes: readonly string[],
  novoTamanho: string,
): string | null {
  const novo = normalizarTamanho(novoTamanho);
  const existentes = tamanhosExistentes.map(normalizarTamanho);
  const jaTemU = existentes.includes(TAMANHO_UNICO);

  if (novo === TAMANHO_UNICO && existentes.length > 0) {
    return "Esta variante já possui tamanhos: o tamanho único (U) não pode coexistir com outros.";
  }
  if (novo !== TAMANHO_UNICO && jaTemU) {
    return "Esta variante usa tamanho único (U): não é possível adicionar outros tamanhos.";
  }
  return null;
}

/**
 * Segmento textual usado no código da variante: MAIÚSCULAS, sem acentos,
 * espaços → "-", sem caracteres especiais e sem "-" duplicados/nas pontas.
 */
export function normalizarSegmentoCodigo(valor: string): string {
  return removerDiacriticos(valor.normalize("NFD"))
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Código da variante (`PROD-0001-AZUL-MARINHO`) — determinístico a partir do
 * código do produto (único) + cor, portanto nunca colide entre produtos
 * diferentes; dentro do mesmo produto, a unicidade de `cor` (normalizada)
 * já impede duas variantes com o mesmo segmento. Por isso não precisa de
 * sequência própria. Gerado uma única vez, na criação — imutável depois,
 * mesmo que a cor seja editada.
 */
export function formatarCodigoVariante(codProduto: string, cor: string): string {
  const segmento = normalizarSegmentoCodigo(cor);
  return segmento ? `${codProduto}-${segmento}` : codProduto;
}
