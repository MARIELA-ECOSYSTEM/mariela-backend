import type { Types } from "mongoose";
import { LIMITE_MIDIAS_POR_PRODUTO } from "../modules/media/media.constants.js";

/**
 * Fase 60.2 — REGRAS da migração dos campos legados (`variante.foto`, `variante.video`, `fotoPrincipalVarianteId`)
 * para a galeria (`midias[]`, `midiaPrincipalId`). Funções puras: recebem o documento cru e devolvem o plano — nada
 * aqui lê nem escreve no banco. O comando (`migrar-midias-legadas.comando.ts`) só executa o plano.
 *
 * Os campos legados nunca são alterados: o plano só ACRESCENTA itens à galeria (e, quando ainda não há principal,
 * define `midiaPrincipalId`).
 */

/** Formato cru lido do MongoDB (sem defaults do Mongoose): todo campo pode faltar ou vir malformado. */
export interface VarianteLegada {
  _id: Types.ObjectId;
  foto?: unknown;
  video?: unknown;
}

export interface MidiaGravada {
  _id: string;
  tipo: string;
  url: string;
  ordem: number;
  varianteId?: Types.ObjectId | null;
}

export interface ProdutoLegado {
  _id: Types.ObjectId;
  __v?: number;
  codProduto?: unknown;
  variantes?: VarianteLegada[];
  fotoPrincipalVarianteId?: Types.ObjectId | null;
  midias?: MidiaGravada[];
  midiaPrincipalId?: string | null;
}

/** Item que o `--apply` acrescenta à galeria — mesmo formato de `MidiaProduto` (Fase 60.1). */
export interface MidiaLegadaNova {
  _id: string;
  tipo: "image" | "video";
  chave: string | null;
  url: string;
  contentType: null;
  tamanho: null;
  nomeOriginal: null;
  origem: "legado";
  varianteId: Types.ObjectId | null;
  ordem: number;
  criadoEm: Date;
  criadoPor: null;
}

export type CampoLegado = "foto" | "video";

/** Ocorrências de DADOS (o produto pode ser migrado mesmo assim; elas vão para o relatório). */
export type Ocorrencia =
  | { tipo: "url_invalida"; varianteId: string; campo: CampoLegado; valor: string }
  | { tipo: "principal_sem_imagem"; varianteId: string }
  | { tipo: "chave_r2_nao_reconhecida"; varianteId: string; campo: CampoLegado };

export type MotivoPendencia = "urls_invalidas" | "limite" | "conflito" | "divergencia_pos_migracao";

export type Desfecho =
  | { status: "sem_midia" }
  | { status: "ja_migrado" }
  | { status: "migrar"; novas: MidiaLegadaNova[]; definirPrincipal: string | null }
  | { status: "pendente"; motivo: MotivoPendencia; detalhes: string[] };

export interface PlanoProduto {
  produtoId: string;
  codProduto: string;
  /** Alguma variante tem `foto`/`video` preenchido (válido ou não). */
  temMidiaLegada: boolean;
  desfecho: Desfecho;
  ocorrencias: Ocorrencia[];
}

/**
 * ID determinístico e estável: produto + variante + campo de origem. Os três são imutáveis (o `_id` da variante
 * nunca muda), então reexecutar a migração sempre gera os mesmos ids — base da idempotência.
 */
export function idMidiaLegada(produtoId: string, varianteId: string, campo: CampoLegado): string {
  return `legado-${produtoId}-${varianteId}-${campo}`;
}

/** Só URLs absolutas http(s) com host. URL externa válida é aceita como legado (não é rejeitada por ser externa). */
export function interpretarUrl(texto: string): URL | null {
  try {
    const url = new URL(texto);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "" ? url : null;
  } catch {
    return null;
  }
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Extensões canônicas que o backend usa nas chaves (`MIME_PERMITIDOS`, primeira extensão de cada tipo). */
const EXTENSOES_DA_CHAVE: Record<"image" | "video", string> = { image: "(jpg|png|webp|gif)", video: "(mp4)" };

/**
 * Chave R2 de uma URL legada — SÓ quando a correspondência é inequívoca: mesma origem e prefixo de caminho da base
 * pública configurada, sem query/fragmento, e caminho exatamente no formato que o backend gera para ESTE produto
 * (`products/{produtoId}/{uuid}.{ext}` com a extensão do tipo). Qualquer outra coisa: sem chave (`null`).
 * `doDominio` indica que a URL está no domínio de mídia mas o caminho não foi reconhecido (vai para o relatório).
 */
export function extrairChaveR2(url: URL, baseUrlPublica: string | null, produtoId: string, tipo: "image" | "video"): { chave: string | null; doDominio: boolean } {
  const base = baseUrlPublica ? interpretarUrl(baseUrlPublica) : null;
  if (!base || url.origin !== base.origin) return { chave: null, doDominio: false };
  const prefixo = `${base.pathname.replace(/\/+$/, "")}/`;
  if (!url.pathname.startsWith(prefixo) || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    return { chave: null, doDominio: true };
  }
  const chave = url.pathname.slice(prefixo.length);
  const formato = new RegExp(`^products/${produtoId}/${UUID}\\.${EXTENSOES_DA_CHAVE[tipo]}$`);
  return formato.test(chave) ? { chave, doDominio: true } : { chave: null, doDominio: true };
}

function descreverValor(valor: unknown): string {
  const texto = typeof valor === "string" ? valor : JSON.stringify(valor) ?? String(valor);
  return texto.length > 120 ? `${texto.slice(0, 117)}...` : texto;
}

/** Calcula o que a migração faria com UM produto. Nunca escolhe o que descartar: em dúvida, pendência sem escrita. */
export function planejarProduto(produto: ProdutoLegado, baseUrlPublica: string | null, agora: Date): PlanoProduto {
  const produtoId = String(produto._id);
  const codProduto = typeof produto.codProduto === "string" ? produto.codProduto : "(sem código)";
  const variantes = Array.isArray(produto.variantes) ? produto.variantes : [];
  const existentes = Array.isArray(produto.midias) ? produto.midias : [];
  const ocorrencias: Ocorrencia[] = [];
  const candidatas: MidiaLegadaNova[] = [];
  let temMidiaLegada = false;

  for (const variante of variantes) {
    const varianteId = String(variante._id);
    for (const campo of ["foto", "video"] as const) {
      const valor = variante[campo];
      if (valor === null || valor === undefined || (typeof valor === "string" && valor.trim() === "")) continue;
      temMidiaLegada = true;
      const texto = typeof valor === "string" ? valor.trim() : null;
      const url = texto === null ? null : interpretarUrl(texto);
      if (texto === null || url === null) {
        ocorrencias.push({ tipo: "url_invalida", varianteId, campo, valor: descreverValor(valor) });
        continue;
      }
      const tipo = campo === "foto" ? "image" : "video";
      const { chave, doDominio } = extrairChaveR2(url, baseUrlPublica, produtoId, tipo);
      if (doDominio && chave === null) ocorrencias.push({ tipo: "chave_r2_nao_reconhecida", varianteId, campo });
      candidatas.push({
        _id: idMidiaLegada(produtoId, varianteId, campo),
        tipo,
        chave,
        url: texto,
        contentType: null,
        tamanho: null,
        nomeOriginal: null,
        origem: "legado",
        // Imagens ficam com a variante de origem; vídeos são do produto.
        varianteId: tipo === "image" ? variante._id : null,
        ordem: 0,
        criadoEm: agora,
        criadoPor: null,
      });
    }
  }

  const principalVarianteId = produto.fotoPrincipalVarianteId ? String(produto.fotoPrincipalVarianteId) : null;
  const imagemDaPrincipal = principalVarianteId
    ? candidatas.find((candidata) => candidata.tipo === "image" && String(candidata.varianteId) === principalVarianteId)
    : undefined;
  if (principalVarianteId && !imagemDaPrincipal) ocorrencias.push({ tipo: "principal_sem_imagem", varianteId: principalVarianteId });

  const plano = (desfecho: Desfecho): PlanoProduto => ({ produtoId, codProduto, temMidiaLegada, desfecho, ocorrencias });
  if (!temMidiaLegada) return plano({ status: "sem_midia" });
  if (candidatas.length === 0) return plano({ status: "pendente", motivo: "urls_invalidas", detalhes: ["nenhuma mídia legada válida para migrar"] });

  const porId = new Map(existentes.map((midia) => [midia._id, midia]));
  const prefixoDoProduto = `legado-${produtoId}-`;
  const jaMigrado = existentes.some((midia) => typeof midia._id === "string" && midia._id.startsWith(prefixoDoProduto));

  const conflitos: string[] = [];
  const ausentes: MidiaLegadaNova[] = [];
  for (const candidata of candidatas) {
    const atual = porId.get(candidata._id);
    if (atual) {
      // A associação à variante pode ter sido alterada depois (ou desfeita pela remoção da variante): não é conflito.
      if (atual.url !== candidata.url || atual.tipo !== candidata.tipo) conflitos.push(`${candidata._id}: já existe na galeria com URL ou tipo diferente`);
      continue;
    }
    const mesmaUrl = existentes.find((midia) => midia.url === candidata.url);
    if (mesmaUrl) {
      conflitos.push(`${candidata._id}: a mesma URL já está na galeria como ${mesmaUrl._id}`);
      continue;
    }
    ausentes.push(candidata);
  }
  if (conflitos.length > 0) return plano({ status: "pendente", motivo: "conflito", detalhes: conflitos });

  if (jaMigrado) {
    if (ausentes.length === 0) return plano({ status: "ja_migrado" });
    // Já migrado antes e agora faltam itens: removidos da galeria por alguém OU variantes novas — indistinguível.
    // Reinserir poderia desfazer uma remoção intencional: pendência, sem escrita.
    return plano({
      status: "pendente",
      motivo: "divergencia_pos_migracao",
      detalhes: ausentes.map((ausente) => `${ausente._id}: mídia legada ausente da galeria de um produto já migrado (removida ou variante nova)`),
    });
  }
  if (ausentes.length === 0) return plano({ status: "ja_migrado" });

  for (const tipo of ["image", "video"] as const) {
    const total = existentes.filter((midia) => midia.tipo === tipo).length + ausentes.filter((ausente) => ausente.tipo === tipo).length;
    const limite = LIMITE_MIDIAS_POR_PRODUTO[tipo];
    if (total > limite) {
      return plano({
        status: "pendente",
        motivo: "limite",
        detalhes: [`${total} ${tipo === "image" ? "imagens" : "vídeos"} após a migração (limite ${limite}); nenhuma mídia é descartada automaticamente`],
      });
    }
  }

  // Ordem: depois das mídias existentes, na ordem das variantes no documento (foto antes do vídeo de cada variante).
  let proxima = existentes.reduce((maior, midia) => Math.max(maior, (typeof midia.ordem === "number" ? midia.ordem : -1) + 1), 0);
  const novas = ausentes.map((ausente) => ({ ...ausente, ordem: proxima++ }));

  // Principal: só quando o produto ainda não tem uma (nunca substitui a da galeria existente).
  const principalAtual = produto.midiaPrincipalId ?? null;
  const definirPrincipal = principalAtual === null && imagemDaPrincipal ? imagemDaPrincipal._id : null;
  return plano({ status: "migrar", novas, definirPrincipal });
}
