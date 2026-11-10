import type { Verificacao } from "./archive.js";
import type { EstadoDestino } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2.11 (X1) — CLASSIFICAÇÃO EXPLÍCITA das falhas de reverificação (PURA).
 *
 * Antes: qualquer falha na reverificação de Liberar/IniciarUso levava o destino a INTERVENCAO_NECESSARIA — inclusive um
 * archive errado informado pelo operador. Agora cada verificação reprovada tem uma CATEGORIA, e só as categorias que
 * provam um problema NO DESTINO (ou na evidência persistida dele) registram intervenção:
 *
 *   ENTRADA_OPERADOR        arquivo inexistente; archive/manifesto INFORMADO com SHA diferente do registrado. Recusa
 *                           SEM alterar estado (o operador corrige e repete).
 *   EVIDENCIA_INCONSISTENTE registro × posse divergentes (escopo `registro_posse`): intervenção registrada;
 *                           registro ausente/cadeia inválida (escopo `registro`): NÃO é possível registrar (a âncora não
 *                           aceita acréscimo) — recusa, intervenção MANUAL;
 *                           artefatos do diretório de backup (.sha256/manifesto) divergentes do archive registrado
 *                           (escopo `artefatos_backup`): o destino não é afetado — recusa sem transição, intervenção MANUAL;
 *                           verificação desconhecida (escopo `desconhecido`): falha FECHADA — recusa, intervenção MANUAL.
 *   POSSE_INVALIDA          posse ausente, de outra execução, de outro banco ou de outra instância: recusa SEM tocar na
 *                           posse (não é desta operação).
 *   DESTINO_ADULTERADO      conteúdo/índices/opções/proteção/coleções/evidências do destino divergentes: intervenção.
 *   FALHA_OPERACIONAL       exceção (conexão, leitura, permissão): recusa SEM alterar estado — nunca vira "adulteração".
 *
 * Prioridade quando há várias (a mais grave vence; ENTRADA_OPERADOR NUNCA esconde uma divergência real):
 *   POSSE_INVALIDA > EVIDENCIA(registro) > EVIDENCIA(registro_posse) > DESTINO_ADULTERADO > EVIDENCIA(desconhecido)
 *   > EVIDENCIA(artefatos_backup) > ENTRADA_OPERADOR.
 */

export type CategoriaFalha = "ENTRADA_OPERADOR" | "EVIDENCIA_INCONSISTENTE" | "POSSE_INVALIDA" | "DESTINO_ADULTERADO" | "FALHA_OPERACIONAL";
export type EscopoEvidencia = "registro" | "registro_posse" | "artefatos_backup" | "desconhecido";

export interface ClassificacaoFalha {
  categoria: CategoriaFalha;
  escopo?: EscopoEvidencia;
  /** Registrar INTERVENCAO_NECESSARIA no banco (só quando a prova é sobre o destino e a âncora aceita o registro). */
  registrarIntervencao: boolean;
  /** O operador precisa intervir manualmente (mesmo quando nada é registrado). */
  intervencaoManual: boolean;
  /** Verificações reprovadas que levaram a esta categoria. */
  ids: string[];
  motivo: string;
}

type Regra = { categoria: Exclude<CategoriaFalha, "FALHA_OPERACIONAL">; escopo?: EscopoEvidencia };

const ENTRADA: Regra = { categoria: "ENTRADA_OPERADOR" };
const POSSE: Regra = { categoria: "POSSE_INVALIDA" };
const REGISTRO: Regra = { categoria: "EVIDENCIA_INCONSISTENTE", escopo: "registro" };
const REG_POSSE: Regra = { categoria: "EVIDENCIA_INCONSISTENTE", escopo: "registro_posse" };
const ARTEFATOS: Regra = { categoria: "EVIDENCIA_INCONSISTENTE", escopo: "artefatos_backup" };
const DESTINO: Regra = { categoria: "DESTINO_ADULTERADO" };

/** Mapa EXPLÍCITO id → categoria. Um id fora dele é tratado como desconhecido (falha fechada). */
export const CATEGORIA_POR_VERIFICACAO: Readonly<Record<string, Regra>> = {
  "ancora.arquivos": ENTRADA,
  "ancora.archive": ENTRADA,
  "ancora.manifesto": ENTRADA,
  "ancora.posse_presente": POSSE,
  "ancora.posse_banco": POSSE,
  "ancora.posse_instancia": POSSE,
  "posse.desta_execucao": POSSE,
  "ancora.presente": REGISTRO,
  "ancora.cadeia": REGISTRO,
  "ancora.execucao": REG_POSSE,
  "ancora.banco": REG_POSSE,
  "ancora.instancia": REG_POSSE,
  "ancora.archive_registro": REG_POSSE,
  "ancora.manifesto_registro": REG_POSSE,
  "ancora.caminhos": REG_POSSE,
  "ancora.estado": REG_POSSE,
  "ancora.evidencias": REG_POSSE,
  "ancora.archive_sha256": ARTEFATOS,
  "ancora.archive_manifesto": ARTEFATOS,
  "destino.colecoes_exatas": DESTINO,
  "destino.protegido": DESTINO,
  "destino.indices_exatos": DESTINO,
  "destino.opcoes_colecao": DESTINO,
  "integridade.conteudo": DESTINO,
  "evidencias.iguais_ao_verificado": DESTINO,
};

const ORDEM: { chave: string; motivo: string; registrar: boolean; manual: boolean }[] = [
  { chave: "POSSE_INVALIDA", motivo: "a posse lida não é desta execução, deste banco ou desta instância — nada é alterado", registrar: false, manual: false },
  { chave: "EVIDENCIA_INCONSISTENTE:registro", motivo: "registro local de evidências ausente ou com cadeia inválida — a divergência NÃO pode ser registrada; intervenção manual", registrar: false, manual: true },
  { chave: "EVIDENCIA_INCONSISTENTE:registro_posse", motivo: "a posse no banco diverge do registro local de evidências", registrar: true, manual: true },
  { chave: "DESTINO_ADULTERADO", motivo: "o destino não confere com o VERIFICADO", registrar: true, manual: true },
  { chave: "EVIDENCIA_INCONSISTENTE:desconhecido", motivo: "verificação reprovada sem classificação conhecida — falha fechada; intervenção manual", registrar: false, manual: true },
  { chave: "EVIDENCIA_INCONSISTENTE:artefatos_backup", motivo: "o .sha256 ou o manifesto do diretório de backup não descrevem o archive registrado — o destino não foi alterado; intervenção manual no backup", registrar: false, manual: true },
  { chave: "ENTRADA_OPERADOR", motivo: "archive/manifesto informado inexistente ou diferente do registrado na aquisição — corrija os arquivos e repita (nada foi alterado)", registrar: false, manual: false },
];

/** Classifica as verificações reprovadas (null = nenhuma falha). PURA. */
export function classificarFalhas(verificacoes: readonly Verificacao[]): ClassificacaoFalha | null {
  const falhas = verificacoes.filter((v) => !v.ok);
  if (!falhas.length) return null;
  const arquivoInformadoErrado = falhas.some((f) => f.id === "ancora.archive" || f.id === "ancora.arquivos");
  const grupos = new Map<string, string[]>();
  for (const f of falhas) {
    let regra: Regra = CATEGORIA_POR_VERIFICACAO[f.id] ?? { categoria: "EVIDENCIA_INCONSISTENTE", escopo: "desconhecido" };
    // Os artefatos ao lado de um archive que NÃO é o registrado descrevem outro backup: é a mesma entrada errada.
    if (regra === ARTEFATOS && arquivoInformadoErrado) regra = ENTRADA;
    const chave = regra.escopo ? `${regra.categoria}:${regra.escopo}` : regra.categoria;
    grupos.set(chave, [...(grupos.get(chave) ?? []), f.id]);
  }
  for (const o of ORDEM) {
    const ids = grupos.get(o.chave);
    if (!ids) continue;
    const [categoria, escopo] = o.chave.split(":") as [CategoriaFalha, EscopoEvidencia | undefined];
    // POSSE de outro banco/instância é anômala (cópia ou adulteração): exige olhar humano, mas nada é tocado.
    const manual = o.manual || (categoria === "POSSE_INVALIDA" && ids.some((i) => i === "ancora.posse_banco" || i === "ancora.posse_instancia"));
    return { categoria, ...(escopo ? { escopo } : {}), registrarIntervencao: o.registrar, intervencaoManual: manual, ids, motivo: o.motivo };
  }
  /* c8 ignore next */
  throw new Error("classificação incompleta");
}

/** Exceção durante a reverificação (conexão, leitura de arquivo, permissão): NUNCA é classificada como adulteração. */
export function classificarExcecao(erro: unknown): ClassificacaoFalha {
  const msg = erro instanceof Error ? erro.message : String(erro);
  return { categoria: "FALHA_OPERACIONAL", registrarIntervencao: false, intervencaoManual: false, ids: [], motivo: `falha operacional (nada foi alterado): ${msg}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Fluxo de LIBERAR / INICIAR USO com portas injetáveis (o CLI liga ao MongoDB; os testes usam um armazenamento falso).

export interface PortasReverificacao {
  /** Reverificação completa (só leitura). Devolve o estado lido da posse desta execução e as verificações. */
  reverificar(): Promise<{ estado: EstadoDestino | null; verificacoes: Verificacao[] }>;
  /** Registra INTERVENCAO_NECESSARIA (âncora + CAS). */
  intervir(motivo: string): Promise<{ ok: boolean; detalhe?: string }>;
  /** A operação pedida (LIBERACAO_AUTORIZADA ou EM_USO), só chamada com tudo conferido. */
  executar(): Promise<{ ok: boolean; estado: EstadoDestino | null; detalhe: string }>;
  /** Trava reconferida imediatamente antes de escrever. */
  exigirTrava(): void;
}

export interface ResultadoOperacao {
  ok: boolean;
  estado: EstadoDestino | null;
  motivo: string;
  categoria: CategoriaFalha | null;
  classificacao: ClassificacaoFalha | null;
  /** A intervenção foi efetivamente registrada (âncora + banco)? */
  intervencaoPersistida: boolean;
  /** Havia divergência que exigia registro, mas o registro falhou (âncora inválida, CAS, conexão). */
  divergenciaNaoRegistravel: boolean;
  verificacoes: Verificacao[];
}

/**
 * Reverifica, CLASSIFICA e só então decide. `estadoExigido` = estado em que a operação é admitida. Nenhuma escrita
 * acontece sem classificação; FALHA_OPERACIONAL e ENTRADA_OPERADOR nunca escrevem.
 */
export async function operarComReverificacao(portas: PortasReverificacao, estadoExigido: EstadoDestino): Promise<ResultadoOperacao> {
  const base = { categoria: null, classificacao: null, intervencaoPersistida: false, divergenciaNaoRegistravel: false } as const;
  let r: { estado: EstadoDestino | null; verificacoes: Verificacao[] };
  try {
    r = await portas.reverificar();
  } catch (erro) {
    const c = classificarExcecao(erro);
    return { ...base, ok: false, estado: null, motivo: c.motivo, categoria: c.categoria, classificacao: c, verificacoes: [] };
  }
  const c = classificarFalhas(r.verificacoes);
  if (c?.categoria === "POSSE_INVALIDA") return { ...base, ok: false, estado: r.estado, motivo: c.motivo, categoria: c.categoria, classificacao: c, verificacoes: r.verificacoes };
  if (r.estado !== estadoExigido) {
    return { ...base, ok: false, estado: r.estado, motivo: `operação exige posse ${estadoExigido} desta execução (estado ${r.estado ?? "desconhecido"})`, categoria: c?.categoria ?? null, classificacao: c, verificacoes: r.verificacoes };
  }
  if (c) {
    if (!c.registrarIntervencao) return { ...base, ok: false, estado: r.estado, motivo: c.motivo, categoria: c.categoria, classificacao: c, verificacoes: r.verificacoes };
    let ti: { ok: boolean; detalhe?: string };
    try {
      ti = await portas.intervir(`${c.categoria}${c.escopo ? `/${c.escopo}` : ""}: ${c.ids.join(", ")}`);
    } catch (erro) {
      ti = { ok: false, detalhe: erro instanceof Error ? erro.message : String(erro) };
    }
    return {
      ...base,
      ok: false,
      estado: ti.ok ? "INTERVENCAO_NECESSARIA" : r.estado,
      motivo: ti.ok ? c.motivo : `${c.motivo} — a intervenção NÃO pôde ser registrada (${ti.detalhe ?? "recusada"}); intervenção manual`,
      categoria: c.categoria,
      classificacao: ti.ok ? c : { ...c, intervencaoManual: true },
      intervencaoPersistida: ti.ok,
      divergenciaNaoRegistravel: !ti.ok,
      verificacoes: r.verificacoes,
    };
  }
  portas.exigirTrava();
  const t = await portas.executar();
  return { ...base, ok: t.ok, estado: t.estado, motivo: t.detalhe, verificacoes: r.verificacoes };
}
