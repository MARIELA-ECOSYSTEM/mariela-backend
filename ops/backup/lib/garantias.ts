import { ESTADOS_DESTINO, garantiasDoEstado, type EstadoDestino } from "./politica.js";

/**
 * Fase 60.4.3.4.21.2.11 (D14/N4) — GARANTIAS EFETIVAS (PURA).
 *
 * `garantiasDoEstado` diz o que um estado DECLARA. Antes, Inspecionar/Verificar devolviam essa declaração mesmo com a
 * âncora inválida, a posse sem identidade ou o destino descongelado. Agora cada garantia tem uma SITUAÇÃO:
 *
 *   COMPROVADA                  conferida nesta consulta (e.g. "protegido": todas as coleções de dados congeladas; "igual
 *                               ao archive": só por Verificar/reverificação completa com sucesso);
 *   DECLARADA_NAO_REVERIFICADA  o estado declara, o registro externo a admite, mas esta consulta NÃO reconferiu o conteúdo
 *                               (Inspecionar nunca compara com o archive) — o valor efetivo é FALSO;
 *   INDISPONIVEL                algum pré-requisito falhou (âncora ausente/inválida/ilegível, estado não admitido pelo
 *                               registro, identidade da posse ou da instância, posse não única, estado desconhecido,
 *                               proteção incompleta, reverificação reprovada) — valor FALSO, com motivo;
 *   NAO_SE_APLICA               o estado não declara a garantia.
 *
 * O valor efetivo (`efetivas`) só é verdadeiro quando COMPROVADA.
 */

export type SituacaoGarantia = "COMPROVADA" | "DECLARADA_NAO_REVERIFICADA" | "INDISPONIVEL" | "NAO_SE_APLICA";
export type NomeGarantia = "igualAoArchive" | "protegido" | "utilizavel";
export type Garantias = Record<NomeGarantia, boolean>;

export interface FatosGarantias {
  /** Estado lido da posse (string bruta: pode ser desconhecido). null = sem posse. */
  estado: string | null;
  /** Documentos na coleção de posse (exatamente 1 é exigido). */
  documentosDePosse: number;
  /** Posse desta execução/banco/instância? */
  identidadePosseOk: boolean;
  /** Identidade da instância comprovada (documento na instância = cópia local)? */
  identidadeInstanciaOk: boolean;
  /** Âncora: presente, cadeia íntegra, estado da posse admitido. `erro` = falha de leitura. */
  ancora: { presente: boolean; cadeiaOk: boolean; estadoAdmitido: boolean; erro?: string | null };
  /** Coleções de dados congeladas / total de coleções de dados. */
  congeladas: number;
  colecoesDeDados: number;
  /** Resultado de uma reverificação COMPLETA nesta consulta (Verificar). undefined = não houve (Inspecionar). */
  reverificacaoOk?: boolean;
}

export interface GarantiasEfetivas {
  declaradas: Garantias | null;
  efetivas: Garantias;
  situacao: Record<NomeGarantia, { situacao: SituacaoGarantia; motivo: string }>;
  /** Pré-requisitos reprovados (motivos), comuns a todas as garantias. */
  indisponiveisPor: string[];
  /** Havia garantia declarada mas a âncora não aceita registrar divergência (ausente/inválida/ilegível). */
  divergenciaNaoRegistravel: boolean;
  /** A posse está persistida em INTERVENCAO_NECESSARIA. */
  intervencaoPersistida: boolean;
}

const NOMES: NomeGarantia[] = ["igualAoArchive", "protegido", "utilizavel"];
const NENHUMA: Garantias = { igualAoArchive: false, protegido: false, utilizavel: false };

export function estadoConhecido(e: string | null): e is EstadoDestino {
  return e !== null && (ESTADOS_DESTINO as readonly string[]).includes(e);
}

export function garantiasEfetivas(f: FatosGarantias): GarantiasEfetivas {
  const conhecido = estadoConhecido(f.estado);
  const declaradas = conhecido ? garantiasDoEstado(f.estado as EstadoDestino) : null;
  const pre: string[] = [];
  if (f.estado === null) pre.push("sem posse");
  else if (!conhecido) pre.push(`estado desconhecido (${f.estado})`);
  if (f.documentosDePosse !== 1) pre.push(`coleção de posse com ${f.documentosDePosse} documento(s)`);
  if (!f.identidadePosseOk) pre.push("posse sem identidade desta execução/banco/instância");
  if (!f.identidadeInstanciaOk) pre.push("identidade da instância não comprovada");
  if (f.ancora.erro) pre.push(`registro local de evidências ilegível (${f.ancora.erro})`);
  else if (!f.ancora.presente) pre.push("registro local de evidências ausente");
  else if (!f.ancora.cadeiaOk) pre.push("registro local de evidências com cadeia inválida");
  else if (!f.ancora.estadoAdmitido) pre.push("estado da posse não admitido pelo registro local");
  if (f.reverificacaoOk === false) pre.push("reverificação completa reprovada");

  const situacao = {} as GarantiasEfetivas["situacao"];
  for (const n of NOMES) {
    if (!declaradas) situacao[n] = { situacao: "INDISPONIVEL", motivo: pre.join("; ") || "estado desconhecido" };
    else if (!declaradas[n]) situacao[n] = { situacao: "NAO_SE_APLICA", motivo: `o estado ${f.estado} não declara esta garantia` };
    else if (pre.length) situacao[n] = { situacao: "INDISPONIVEL", motivo: pre.join("; ") };
    else if (n === "protegido") {
      const completo = f.colecoesDeDados > 0 && f.congeladas === f.colecoesDeDados;
      situacao[n] = completo ? { situacao: "COMPROVADA", motivo: `${f.congeladas}/${f.colecoesDeDados} coleções congeladas (validador, strict, error)` } : { situacao: "INDISPONIVEL", motivo: `proteção incompleta: ${f.congeladas}/${f.colecoesDeDados} coleções congeladas` };
    } else if (n === "igualAoArchive") {
      situacao[n] = f.reverificacaoOk === true ? { situacao: "COMPROVADA", motivo: "reverificação completa nesta consulta (conteúdo, índices, opções, evidências)" } : { situacao: "DECLARADA_NAO_REVERIFICADA", motivo: "declarada pelo estado e admitida pelo registro; NÃO reconferida nesta consulta (use -Acao Verificar)" };
    } else situacao[n] = { situacao: "COMPROVADA", motivo: "estado confirmado pelo registro local e pela identidade" };
  }
  const efetivas = { ...NENHUMA };
  for (const n of NOMES) efetivas[n] = situacao[n].situacao === "COMPROVADA";
  const algumaDeclarada = !!declaradas && NOMES.some((n) => declaradas[n]);
  const ancoraRuim = !!f.ancora.erro || !f.ancora.presente || !f.ancora.cadeiaOk;
  return {
    declaradas,
    efetivas,
    situacao,
    indisponiveisPor: pre,
    divergenciaNaoRegistravel: algumaDeclarada && ancoraRuim,
    intervencaoPersistida: f.estado === "INTERVENCAO_NECESSARIA",
  };
}
