import type { Db } from "mongodb";
import { partesDaVersao, verificarArchiveContraPolitica, type ArchiveLido, type IndiceNormalizado, type Verificacao } from "./archive.js";
import { compararAssinaturas, lerIndices, lerReferencias, lerSequencias, type Assinatura, type EstadoSequencia } from "./janela.js";
import { BANCO_ORIGEM, COLECOES_BACKUP, COLECOES_EXCLUIDAS, DECLARACAO_CONSISTENCIA, INDICES_REFERENCIA, JANELA, RESTORE } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2 — manifesto de um backup. Estado `VALIDO_LOCAL` SÓ se TODAS as validações passam (falha
 * fechada); `avisos` nunca tornam um backup válido nem inválido. O manifesto não contém URI, host, documento ou dado
 * pessoal: só nomes de coleção, contagens, timestamps máximos, hashes, índices e versões.
 */

export const FORMATO_MANIFESTO = "mariela-backup-manifesto/1";

export interface Manifesto {
  formato: typeof FORMATO_MANIFESTO;
  execucaoId: string;
  tipo: "diario" | "extraordinario";
  estado: "VALIDO_LOCAL" | "INVALIDO";
  iniciadoEm: string;
  concluidoEm: string;
  dataLocal: string;
  fusoHorario: string;
  ferramentas: { mongodump: string | null };
  servidor: { versao: string | null };
  origem: { banco: string };
  politica: { colecoesIncluidas: string[]; colecoesExcluidas: string[]; indicesReferencia: number };
  janela: { horaAlvo: string; quietMinutos: number; verificacoes: Verificacao[]; informacoes: Record<string, number> };
  assinaturaAntes: Assinatura | null;
  assinaturaDepois: Assinatura | null;
  indices: { porColecao: Record<string, IndiceNormalizado[]>; total: number } | null;
  referencias: Record<string, number> | null;
  sequencias: Record<string, EstadoSequencia> | null;
  archive: {
    arquivo: string;
    tamanhoBytes: number;
    sha256: string;
    versaoServidor: string | null;
    versaoFerramenta: string | null;
    documentosPorColecao: Record<string, number>;
  } | null;
  validacoes: Verificacao[];
  avisos: string[];
  consistencia: string;
}

/** Resultado do pré-backup (elegibilidade + estado da origem antes do dump). */
export interface PreBackup {
  elegivel: boolean;
  motivo: string;
  agora: string;
  versaoServidor: string | null;
  verificacoes: Verificacao[];
  informacoes: Record<string, number>;
  colecoesExistentes: string[];
  exclusoes: string[];
  assinatura: Assinatura | null;
  indices: Record<string, IndiceNormalizado[]> | null;
  referencias: Record<string, number> | null;
  sequencias: Record<string, EstadoSequencia> | null;
}

const iguaisJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Validações do archive recém-gerado contra a origem lida antes/depois do dump. */
export function validarBackup(pre: PreBackup, depois: Assinatura, archive: ArchiveLido): { validacoes: Verificacao[]; avisos: string[] } {
  const validacoes: Verificacao[] = [...verificarArchiveContraPolitica(archive, BANCO_ORIGEM, COLECOES_BACKUP)];
  const avisos: string[] = [];

  validacoes.push({ id: "pre.elegivel", ok: pre.elegivel, detalhe: pre.motivo });
  const comparacao = pre.assinatura ? compararAssinaturas(pre.assinatura, depois) : { iguais: false, divergentes: ["(sem assinatura antes)"] };
  validacoes.push({
    id: "consistencia.assinaturas_iguais",
    ok: comparacao.iguais,
    detalhe: comparacao.iguais ? "nenhuma escrita detectada entre antes e depois do dump" : `escrita detectada em: ${comparacao.divergentes.join(", ")}`,
  });

  const contagensDivergentes = COLECOES_BACKUP.filter((c) => (archive.documentos[`${BANCO_ORIGEM}.${c}`] ?? 0) !== (depois[c]?.contagem ?? -1));
  validacoes.push({
    id: "archive.contagens_iguais_origem",
    ok: contagensDivergentes.length === 0,
    detalhe: contagensDivergentes.length ? `divergem: ${contagensDivergentes.map((c) => `${c}(archive=${archive.documentos[`${BANCO_ORIGEM}.${c}`] ?? 0}, origem=${depois[c]?.contagem ?? "?"})`).join(", ")}` : "27 contagens iguais",
  });

  const indicesDivergentes = COLECOES_BACKUP.filter((c) => {
    const doArchive = archive.colecoes.find((x) => x.colecao === c)?.indices;
    return !doArchive || !pre.indices || !iguaisJson(doArchive, pre.indices[c]);
  });
  validacoes.push({
    id: "archive.indices_iguais_origem",
    ok: indicesDivergentes.length === 0,
    detalhe: indicesDivergentes.length ? `divergem: ${indicesDivergentes.join(", ")}` : "índices do archive idênticos aos da origem",
  });

  validacoes.push({
    id: "archive.versao_igual_origem",
    ok: !!archive.versaoServidor && archive.versaoServidor === pre.versaoServidor,
    detalhe: `archive=${archive.versaoServidor ?? "?"} origem=${pre.versaoServidor ?? "?"}`,
  });

  const opcoesEspeciais = archive.colecoes.filter((c) => Object.keys(c.opcoes).length > 0 || c.tipo !== "collection").map((c) => c.colecao);
  if (opcoesEspeciais.length) avisos.push(`coleções com opções/tipo especiais (validators, views…): ${opcoesEspeciais.join(", ")} — revisar a política`);
  const total = Object.values(pre.indices ?? {}).reduce((s, l) => s + l.length, 0);
  if (total !== INDICES_REFERENCIA) avisos.push(`total de índices (${total}) difere da referência de 09/11/2026 (${INDICES_REFERENCIA}) — esperado se o schema mudou`);
  const seqRuins = Object.entries(pre.sequencias ?? {}).filter(([, s]) => !s.ok).map(([k]) => k);
  if (seqRuins.length) avisos.push(`sequências da ORIGEM abaixo do maior código emitido: ${seqRuins.join(", ")} (o backup reproduz a origem)`);
  const orfas = Object.entries(pre.referencias ?? {}).filter(([, n]) => n > 0);
  if (orfas.length) avisos.push(`referências órfãs na ORIGEM: ${orfas.map(([k, n]) => `${k}=${n}`).join(", ")} (o backup reproduz a origem)`);
  return { validacoes, avisos };
}

export function montarManifesto(dados: Omit<Manifesto, "formato" | "estado" | "politica" | "consistencia" | "janela"> & { janela: Omit<Manifesto["janela"], "horaAlvo" | "quietMinutos"> }): Manifesto {
  const estado = dados.validacoes.length > 0 && dados.validacoes.every((v) => v.ok) && dados.archive !== null ? "VALIDO_LOCAL" : "INVALIDO";
  return {
    formato: FORMATO_MANIFESTO,
    ...dados,
    estado,
    politica: { colecoesIncluidas: [...COLECOES_BACKUP], colecoesExcluidas: [...COLECOES_EXCLUIDAS], indicesReferencia: INDICES_REFERENCIA },
    janela: {
      horaAlvo: `${String(JANELA.horaAlvo).padStart(2, "0")}:${String(JANELA.minutoAlvo).padStart(2, "0")}`,
      quietMinutos: JANELA.quietMinutos,
      ...dados.janela,
    },
    consistencia: DECLARACAO_CONSISTENCIA,
  };
}

/** Antes de restaurar: o archive confere com o manifesto (política, contagens, versão). */
export function validarArchiveParaRestore(archive: ArchiveLido, manifesto: Manifesto): Verificacao[] {
  const v = verificarArchiveContraPolitica(archive, BANCO_ORIGEM, COLECOES_BACKUP);
  v.push({ id: "manifesto.estado", ok: manifesto.estado === "VALIDO_LOCAL" && manifesto.formato === FORMATO_MANIFESTO, detalhe: `estado=${manifesto.estado}` });
  const divergentes = COLECOES_BACKUP.filter((c) => (archive.documentos[`${BANCO_ORIGEM}.${c}`] ?? 0) !== (manifesto.archive?.documentosPorColecao[c] ?? -1));
  v.push({ id: "archive.contagens_iguais_manifesto", ok: divergentes.length === 0, detalhe: divergentes.length ? `divergem: ${divergentes.join(", ")}` : "27 contagens iguais ao manifesto" });
  v.push({
    id: "archive.versao_igual_manifesto",
    ok: !!archive.versaoServidor && archive.versaoServidor === manifesto.archive?.versaoServidor,
    detalhe: `archive=${archive.versaoServidor ?? "?"} manifesto=${manifesto.archive?.versaoServidor ?? "?"}`,
  });
  return v;
}

/** O servidor de destino é compatível com a origem? Exige MESMA série maior.menor (ex.: 8.0); diferença de correção é registrada. */
export function verificarVersaoDestino(versaoOrigem: string | null, versaoDestino: string | null): Verificacao {
  const o = partesDaVersao(versaoOrigem);
  const d = partesDaVersao(versaoDestino);
  const ok = !!o && !!d && o.maior === d.maior && o.menor === d.menor;
  const igual = ok && o!.correcao === d!.correcao;
  return {
    id: "restore.versao_compativel",
    ok,
    detalhe: `origem=${versaoOrigem ?? "?"} destino=${versaoDestino ?? "?"}${ok && !igual ? " (mesma série; correção diferente — registrado)" : ""}`,
  };
}

/** Depois do restore: coleções, contagens, índices, referências e sequências idênticos ao manifesto. */
export async function validarRestaurado(db: Db, manifesto: Manifesto): Promise<Verificacao[]> {
  const v: Verificacao[] = [];
  // A coleção de POSSE (Fase 21.2.4) é da execução, não do archive: fora da comparação (qualquer OUTRA coleção conta).
  const nomes = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith("system.") && n !== RESTORE.colecaoPosse)
    .sort();
  const esperadas = [...COLECOES_BACKUP].sort();
  v.push({ id: "restaurado.colecoes_exatas", ok: iguaisJson(nomes, esperadas), detalhe: `${nomes.length} coleções; esperadas ${esperadas.length}` });

  const contagens: string[] = [];
  for (const c of COLECOES_BACKUP) {
    const n = await db.collection(c).countDocuments({});
    if (n !== manifesto.assinaturaDepois?.[c]?.contagem) contagens.push(`${c}(restaurado=${n}, manifesto=${manifesto.assinaturaDepois?.[c]?.contagem ?? "?"})`);
  }
  v.push({ id: "restaurado.contagens", ok: contagens.length === 0, detalhe: contagens.length ? contagens.join(", ") : "27 contagens iguais ao manifesto" });

  const indices = await lerIndices(db, COLECOES_BACKUP);
  const idxDiv = COLECOES_BACKUP.filter((c) => !iguaisJson(indices[c], manifesto.indices?.porColecao[c]));
  const total = Object.values(indices).reduce((s, l) => s + l.length, 0);
  v.push({ id: "restaurado.indices", ok: idxDiv.length === 0, detalhe: idxDiv.length ? `divergem: ${idxDiv.join(", ")}` : `${total} índices idênticos ao manifesto` });

  const refs = await lerReferencias(db);
  v.push({ id: "restaurado.referencias", ok: iguaisJson(refs, manifesto.referencias), detalhe: `órfãos=${JSON.stringify(refs)}` });

  const seqs = await lerSequencias(db);
  v.push({ id: "restaurado.sequencias", ok: iguaisJson(seqs, manifesto.sequencias), detalhe: Object.entries(seqs).map(([k, s]) => `${k}:${s.valor ?? "-"}/${s.maiorEmitido ?? "-"}`).join(" ") });
  return v;
}
