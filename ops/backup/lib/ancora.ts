import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Verificacao } from "./archive.js";
import { raizIsolada } from "./instancia.js";
import { RESTORE, type EstadoDestino } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2.8 (A21-7-02) — ÂNCORA DE CONFIANÇA EXTERNA AO BANCO.
 *
 * A posse vive no próprio banco de destino e o guardião (que precisa transicioná-la) consegue reescrevê-la. Por isso cada
 * execução tem também um REGISTRO LOCAL de evidências: `<raiz>/evidencias/<banco>__<execucaoId>.jsonl`, uma linha JSON
 * por evento, encadeada por hash (`anterior` = SHA-256 da linha anterior; a primeira usa "GENESIS"). O arquivo é criado
 * com `wx` (nunca reaproveitado) e só recebe acréscimos.
 *
 * Cada transição grava INTENÇÃO (antes do compare-and-set no banco) e CONFIRMAÇÃO (depois). Uma queda entre os dois deixa
 * um estado verificável: o banco está no `de` ou no `para` da última intenção.
 *
 * O que a âncora DETECTA: posse adulterada (SHA, caminhos, estado, banco, instância, evidências) sem a mesma adulteração
 * no registro; registro editado no meio (cadeia quebrada); archive/manifesto trocados (SHA conferido contra o próprio
 * arquivo, o `.sha256` e o manifesto do diretório de backup).
 * O que NÃO detecta: um processo da MESMA conta Windows que reescreva, de forma coerente, o registro INTEIRO, a posse e
 * os arquivos do backup. Não há chave secreta (exigiria aprovação do operador); a âncora é tamper-EVIDENT, não
 * tamper-PROOF.
 */

export interface ArquivoAncorado {
  caminho: string;
  sha256: string;
}

export interface EvidenciasAncoradas {
  documentos: number;
  hashesPorColecao: Record<string, string>;
  uuidsPorColecao: Record<string, string>;
}

export interface EventoAncora {
  evento: "POSSE" | "INTENCAO" | "CONFIRMACAO" | "EVIDENCIAS";
  banco: string;
  execucaoId: string;
  instanciaId: string;
  estado?: EstadoDestino;
  de?: EstadoDestino;
  para?: EstadoDestino;
  archive?: ArquivoAncorado;
  manifesto?: ArquivoAncorado;
  evidencias?: EvidenciasAncoradas;
  detalhe?: string;
}

export interface EntradaAncora extends EventoAncora {
  seq: number;
  em: string;
  anterior: string;
}

const GENESIS = "GENESIS";
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

export function caminhoAncora(raiz: string | undefined, banco: string, execucaoId: string): string {
  return join(raizIsolada(raiz), RESTORE.pastaEvidencias, `${banco}__${execucaoId}.jsonl`);
}

/** Próxima linha do registro (PURA). */
export function proximaLinha(textoAtual: string, evento: EventoAncora, agora: Date = new Date()): string {
  const linhas = textoAtual.split("\n").filter((l) => l.trim());
  const ultima = linhas[linhas.length - 1];
  const entrada: EntradaAncora = { seq: linhas.length + 1, em: agora.toISOString(), anterior: ultima ? sha(ultima) : GENESIS, ...evento };
  return JSON.stringify(entrada);
}

/** Lê e valida a cadeia (PURA). Qualquer linha ilegível, fora de sequência ou com hash anterior errado ⇒ inválido. */
export function lerCadeia(texto: string): { ok: boolean; entradas: EntradaAncora[]; motivo: string } {
  const linhas = texto.split("\n").filter((l) => l.trim());
  if (!linhas.length) return { ok: false, entradas: [], motivo: "registro de evidências vazio" };
  // Fase 21.2.11 (N2): o formato é UTF-8 + LF, cada linha terminada. CR ou BOM ⇒ o arquivo foi regravado por outra
  // ferramenta; última linha sem LF ⇒ escrita interrompida (registro incompleto). Ambos falham fechado.
  if (texto.charCodeAt(0) === 0xfeff) return { ok: false, entradas: [], motivo: "registro com BOM (regravado fora do formato UTF-8 sem BOM)" };
  if (texto.includes("\r")) return { ok: false, entradas: [], motivo: "registro com terminador CR/CRLF (regravado fora do formato LF)" };
  if (!texto.endsWith("\n")) return { ok: false, entradas: [], motivo: "registro INCOMPLETO: última linha sem terminador (escrita interrompida)" };
  const entradas: EntradaAncora[] = [];
  let anterior = GENESIS;
  for (let i = 0; i < linhas.length; i += 1) {
    let e: EntradaAncora;
    try {
      e = JSON.parse(linhas[i]!) as EntradaAncora;
    } catch {
      return { ok: false, entradas, motivo: `linha ${i + 1} ilegível` };
    }
    if (e.seq !== i + 1) return { ok: false, entradas, motivo: `sequência quebrada na linha ${i + 1}` };
    if (e.anterior !== anterior) return { ok: false, entradas, motivo: `cadeia de hash quebrada na linha ${i + 1}` };
    anterior = sha(linhas[i]!);
    entradas.push(e);
  }
  if (entradas[0]!.evento !== "POSSE") return { ok: false, entradas, motivo: "o registro não começa pela aquisição da posse" };
  const { banco, execucaoId, instanciaId } = entradas[0]!;
  if (entradas.some((e) => e.banco !== banco || e.execucaoId !== execucaoId || e.instanciaId !== instanciaId)) return { ok: false, entradas, motivo: "entradas de outro banco/execução/instância no mesmo registro" };
  return { ok: true, entradas, motivo: "cadeia íntegra" };
}

/**
 * Estado que o registro admite para o banco (PURA): o último CONFIRMADO; se a última entrada for uma INTENÇÃO sem
 * confirmação (queda no meio), o banco pode estar no `de` OU no `para` dela.
 */
export function estadosAdmitidos(entradas: EntradaAncora[]): EstadoDestino[] {
  let confirmado: EstadoDestino | undefined;
  let pendente: EntradaAncora | undefined;
  for (const e of entradas) {
    if (e.evento === "POSSE") confirmado = "PREPARANDO";
    else if (e.evento === "INTENCAO") pendente = e;
    else if (e.evento === "CONFIRMACAO") {
      confirmado = e.para;
      pendente = undefined;
    }
  }
  if (pendente) return [pendente.de!, pendente.para!];
  return confirmado ? [confirmado] : [];
}

export function ultimasEvidencias(entradas: EntradaAncora[]): EvidenciasAncoradas | null {
  for (let i = entradas.length - 1; i >= 0; i -= 1) if (entradas[i]!.evento === "EVIDENCIAS" && entradas[i]!.evidencias) return entradas[i]!.evidencias!;
  return null;
}

export interface FatosAtuais {
  banco: string;
  instanciaId: string;
  /** Posse lida do banco. */
  posse: { execucaoId: string; estado: EstadoDestino; banco?: string; instanciaId?: string; archiveSha256?: string; manifestoSha256?: string; archive?: string; manifesto?: string; evidencias?: EvidenciasAncoradas } | null;
  /** SHA-256 calculado AGORA dos arquivos informados pelo OPERADOR. */
  archiveInformado: ArquivoAncorado;
  manifestoInformado: ArquivoAncorado;
  /** Conteúdo do `<archive>.sha256` do diretório de backup (1º campo) e o `archive.sha256` do manifesto informado. */
  shaDoArquivoSha256: string | null;
  shaDoManifesto: string | null;
}

/**
 * Confere a âncora externa contra a posse e os arquivos informados pelo operador (PURA).
 *
 * Fase 21.2.11 (X1): verificações GRANULARES, para que a classificação (classificacao.ts) distinga:
 *   - registro × posse (evidência persistida):  ancora.execucao, .banco, .instancia, .archive_registro,
 *     .manifesto_registro, .caminhos, .estado, .evidencias, .cadeia, .presente;
 *   - posse × contexto atual (posse válida):     ancora.posse_presente, .posse_banco, .posse_instancia;
 *   - arquivo INFORMADO pelo operador × registro: ancora.archive, .manifesto;
 *   - artefatos do diretório de backup × arquivo informado: ancora.archive_sha256, .archive_manifesto.
 */
export function conferirAncora(texto: string | null, f: FatosAtuais): Verificacao[] {
  const v: Verificacao[] = [];
  const add = (id: string, ok: boolean, detalhe: string) => v.push({ id, ok, detalhe });
  if (texto === null) {
    add("ancora.presente", false, "registro local de evidências AUSENTE");
    return v;
  }
  const cadeia = lerCadeia(texto);
  add("ancora.cadeia", cadeia.ok, cadeia.motivo);
  if (!cadeia.ok) return v;
  const posseReg = cadeia.entradas[0]!;
  const p = f.posse;
  add("ancora.posse_presente", !!p, p ? "posse lida do banco" : "sem posse no banco");
  if (!p) return v;
  // registro × posse × contexto
  add("ancora.execucao", posseReg.execucaoId === p.execucaoId, `registro=${posseReg.execucaoId} posse=${p.execucaoId}`);
  add("ancora.banco", posseReg.banco === f.banco, `registro=${posseReg.banco} destino=${f.banco}`);
  add("ancora.instancia", posseReg.instanciaId === f.instanciaId, `registro=${posseReg.instanciaId} instância=${f.instanciaId}`);
  add("ancora.posse_banco", p.banco === f.banco, `posse=${p.banco ?? "?"} destino=${f.banco}`);
  add("ancora.posse_instancia", p.instanciaId === f.instanciaId, `posse=${p.instanciaId ?? "?"} instância=${f.instanciaId}`);
  const a = posseReg.archive;
  const m = posseReg.manifesto;
  const up = (x: string | null | undefined) => (x ?? "").toUpperCase();
  add("ancora.archive_registro", !!a && up(a.sha256) === up(p.archiveSha256), "SHA-256 do archive: registro = posse");
  add("ancora.manifesto_registro", !!m && up(m.sha256) === up(p.manifestoSha256), "SHA-256 do manifesto: registro = posse");
  // arquivos INFORMADOS pelo operador × registro
  const shaArch = up(f.archiveInformado.sha256);
  const shaMan = up(f.manifestoInformado.sha256);
  add("ancora.archive", !!a && up(a.sha256) === shaArch, "SHA-256 do archive INFORMADO = registrado na aquisição");
  add("ancora.manifesto", !!m && up(m.sha256) === shaMan, "SHA-256 do manifesto INFORMADO = registrado na aquisição");
  // artefatos do diretório de backup (ao lado do archive informado) × archive informado
  add("ancora.archive_sha256", up(f.shaDoArquivoSha256) === shaArch, ".sha256 do diretório de backup = archive informado");
  add("ancora.archive_manifesto", up(f.shaDoManifesto) === shaArch, "archive.sha256 do manifesto informado = archive informado");
  add("ancora.caminhos", !!a && !!m && (p.archive ?? "") === a.caminho && (p.manifesto ?? "") === m.caminho, "caminhos da posse = caminhos registrados na aquisição");
  const admitidos = estadosAdmitidos(cadeia.entradas);
  add("ancora.estado", admitidos.includes(p.estado), `posse=${p.estado}; registro admite ${admitidos.join(" ou ") || "(nenhum)"}`);
  const ev = ultimasEvidencias(cadeia.entradas);
  if (ev || p.evidencias) {
    const iguais = !!ev && !!p.evidencias && JSON.stringify(ev.hashesPorColecao) === JSON.stringify(p.evidencias.hashesPorColecao) && JSON.stringify(ev.uuidsPorColecao) === JSON.stringify(p.evidencias.uuidsPorColecao) && ev.documentos === p.evidencias.documentos;
    add("ancora.evidencias", iguais, iguais ? "evidências da posse = evidências registradas" : "evidências da posse DIFERENTES das registradas (ou ausentes de um dos lados)");
  }
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// E/S (finas)

export function lerAncora(raiz: string | undefined, banco: string, execucaoId: string): string | null {
  const c = caminhoAncora(raiz, banco, execucaoId);
  return existsSync(c) ? readFileSync(c, "utf8") : null;
}

/**
 * Fase 21.2.11 (N2) — ESCRITA DURÁVEL. Operações de arquivo injetáveis (testes simulam falha em cada etapa).
 * Sequência: abrir → escrever → fsync do ARQUIVO → fechar → (fora do Windows) fsync do DIRETÓRIO.
 * Qualquer erro é PROPAGADO: a transição é abortada ANTES do compare-and-set no banco (a intenção vem antes do CAS).
 * Limite: `fsync` pede ao SO que descarregue para o dispositivo; não garante contra cache de escrita volátil do disco,
 * controladora ou filesystem que ignore o pedido. No Windows o fsync de diretório não é suportado pelo Node/Bun (o
 * NTFS registra metadados no journal); é pulado e documentado.
 */
export interface OperacoesArquivo {
  abrir(caminho: string, flag: "wx" | "a"): number;
  escrever(fd: number, dados: Buffer): void;
  sincronizar(fd: number): void;
  fechar(fd: number): void;
  sincronizarDiretorio(diretorio: string): void;
}

export const ARQUIVO_REAL: OperacoesArquivo = {
  abrir: (c, flag) => openSync(c, flag),
  escrever: (fd, dados) => {
    let escrito = 0;
    while (escrito < dados.length) escrito += writeSync(fd, dados, escrito, dados.length - escrito);
  },
  sincronizar: (fd) => fsyncSync(fd),
  fechar: (fd) => closeSync(fd),
  sincronizarDiretorio: (d) => {
    if (process.platform === "win32") return;
    const fd = openSync(d, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
};

/** Grava `texto` (UTF-8, sem BOM) de forma durável; propaga qualquer erro (o fd é fechado mesmo em falha). */
export function gravarDuravel(caminho: string, texto: string, flag: "wx" | "a", fs: OperacoesArquivo = ARQUIVO_REAL): void {
  const fd = fs.abrir(caminho, flag);
  let erro: unknown = null;
  try {
    fs.escrever(fd, Buffer.from(texto, "utf8"));
    fs.sincronizar(fd);
  } catch (e) {
    erro = e;
  }
  try {
    fs.fechar(fd);
  } catch (e) {
    erro ??= e;
  }
  if (erro) throw erro;
  fs.sincronizarDiretorio(dirname(caminho));
}

/** Cria o registro (falha se já existir) com o evento POSSE. A pasta deve ter sido criada com ACL restrita pelo PowerShell. */
export function criarAncora(raiz: string | undefined, evento: EventoAncora, fs: OperacoesArquivo = ARQUIVO_REAL): void {
  const c = caminhoAncora(raiz, evento.banco, evento.execucaoId);
  mkdirSync(join(raizIsolada(raiz), RESTORE.pastaEvidencias), { recursive: true });
  gravarDuravel(c, `${proximaLinha("", evento)}\n`, "wx", fs); // nunca reaproveita um registro existente
}

export function acrescentarAncora(raiz: string | undefined, evento: EventoAncora, fs: OperacoesArquivo = ARQUIVO_REAL): void {
  const atual = lerAncora(raiz, evento.banco, evento.execucaoId);
  if (atual === null) throw new Error("registro local de evidências ausente — nada é transicionado sem âncora");
  const cadeia = lerCadeia(atual);
  if (!cadeia.ok) throw new Error(`registro local de evidências inválido (${cadeia.motivo}) — nada é transicionado`);
  gravarDuravel(caminhoAncora(raiz, evento.banco, evento.execucaoId), `${proximaLinha(atual, evento)}\n`, "a", fs);
}
