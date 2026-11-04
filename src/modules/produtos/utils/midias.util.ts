import type { Types } from "mongoose";

/**
 * Fase 60.1 — leitura da galeria (`Produto.midias`/`midiaPrincipalId`) com compatibilidade legada. Única fonte
 * destas regras: PDV, Estoque e Vendas chamam estas funções, nunca reimplementam a decisão.
 *
 * Regra de transição: quando a galeria tem ao menos uma imagem, ela é a fonte; senão vale EXATAMENTE a regra
 * legada (`variante.foto`/`fotoPrincipalVarianteId`), que estas funções nunca alteram.
 */
export interface MidiaParaLeitura {
  _id: string;
  tipo: string;
  url: string;
  ordem: number;
  varianteId: Types.ObjectId | null;
}

export interface GaleriaParaLeitura {
  midias: readonly MidiaParaLeitura[];
  midiaPrincipalId: string | null;
}

/** Imagens da galeria pela `ordem` (desempate estável pela posição no array). */
export function imagensOrdenadas<T extends MidiaParaLeitura>(midias: readonly T[]): T[] {
  return midias.filter((midia) => midia.tipo === "image").sort((a, b) => a.ordem - b.ordem);
}

/** Galeria em ordem de exibição (imagens e vídeos), sem alterar o array original. */
export function midiasOrdenadas<T extends MidiaParaLeitura>(midias: readonly T[]): T[] {
  return [...midias].sort((a, b) => a.ordem - b.ordem);
}

/** `_id` da imagem principal: a marcada, se ainda for uma imagem do produto; senão a primeira imagem pela ordem. */
export function idImagemPrincipal(produto: GaleriaParaLeitura): string | null {
  const imagens = imagensOrdenadas(produto.midias);
  const marcada = imagens.find((midia) => midia._id === produto.midiaPrincipalId);
  return (marcada ?? imagens[0])?._id ?? null;
}

/** URL da imagem principal pela galeria, ou `null` quando a galeria não tem imagens (o chamador usa o legado). */
export function urlImagemPrincipalDaGaleria(produto: GaleriaParaLeitura): string | null {
  const id = idImagemPrincipal(produto);
  return produto.midias.find((midia) => midia._id === id)?.url ?? null;
}

/** URLs das imagens da galeria pela ordem (vazio quando não há imagens). */
export function urlsImagensDaGaleria(produto: GaleriaParaLeitura): string[] {
  return imagensOrdenadas(produto.midias).map((midia) => midia.url);
}

/**
 * Foto de uma variante: a primeira imagem da galeria associada a ela (pela ordem); sem imagem associada, a
 * `variante.foto` legada — a mesma de antes da galeria existir.
 */
export function fotoDaVariante(produto: GaleriaParaLeitura, variante: { _id: Types.ObjectId; foto: string | null }): string | null {
  const id = String(variante._id);
  const associada = imagensOrdenadas(produto.midias).find((midia) => midia.varianteId !== null && String(midia.varianteId) === id);
  return associada?.url ?? variante.foto;
}
