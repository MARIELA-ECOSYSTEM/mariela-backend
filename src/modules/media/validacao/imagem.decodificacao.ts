import { recusa } from "./bytes.util.js";

/** Formato que o `Bun.Image` precisa detectar NO CONTEÚDO para cada MIME declarado. */
const FORMATO_ESPERADO: Readonly<Record<string, string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function codigoDeErro(erro: unknown): string | null {
  return erro instanceof Error && "code" in erro && typeof erro.code === "string" ? erro.code : null;
}

/**
 * Erros do `Bun.Image` que significam "conteúdo inválido" viram recusa; qualquer outro (falha inesperada do runtime)
 * é relançado e tratado como indisponibilidade do validador (503), nunca como arquivo inválido.
 */
function comoRecusa(erro: unknown): unknown {
  switch (codigoDeErro(erro)) {
    case "ERR_IMAGE_TOO_MANY_PIXELS":
      return recusa("dimensoes", "Bun.Image: acima de maxPixels");
    case "ERR_IMAGE_UNKNOWN_FORMAT":
    case "ERR_IMAGE_FORMAT_UNSUPPORTED":
      return recusa("formato", `Bun.Image: ${codigoDeErro(erro)}`);
    case "ERR_IMAGE_DECODE_FAILED":
      return recusa("decodificacao", "Bun.Image: falha ao decodificar");
    default:
      return erro;
  }
}

/**
 * Fase 60.4.3.4.1 — camada B: decodificação REAL com o `Bun.Image` do runtime (libjpeg-turbo, libspng, libwebp e
 * decodificador de GIF embutidos; sem dependência npm). `maxPixels` é conferido no cabeçalho, antes de alocar pixels.
 * A saída de 8×8 só força o pipeline completo; para JPEG, o redimensionamento usa IDCT escalado (todos os
 * coeficientes são decodificados, sem materializar a resolução cheia). GIF: só o 1º quadro (os demais são da camada A).
 *
 * Roda dentro do subprocesso do validador. Cada `Bun.Image` recebe uma CÓPIA dos bytes: o runtime pode desanexar o
 * buffer de entrada durante a decodificação.
 */
export async function decodificarImagem(contentType: string, bytes: Uint8Array, maxPixels: number): Promise<{ largura: number; altura: number }> {
  const esperado = FORMATO_ESPERADO[contentType];
  if (!esperado) throw recusa("formato", `tipo de imagem não suportado: ${contentType}`);
  // Mesmo pipeline portátil no Windows (desenvolvimento) e no Linux (produção).
  Bun.Image.backend = "bun";
  const opcoes = { maxPixels, autoOrient: false };
  try {
    const metadados = await new Bun.Image(bytes.slice(), opcoes).metadata();
    if (metadados.format !== esperado) throw recusa("formato", `Bun.Image detectou ${metadados.format}, declarado ${esperado}`);
    await new Bun.Image(bytes.slice(), opcoes).resize(8, 8, { filter: "box" }).png({ compressionLevel: 0 }).bytes();
    return { largura: metadados.width, altura: metadados.height };
  } catch (erro) {
    throw comoRecusa(erro);
  }
}
