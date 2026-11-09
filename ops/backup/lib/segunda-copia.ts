import { statSync } from "node:fs";
import { sha256DoArquivo } from "./archive.js";

/**
 * Fase 60.4.3.4.21.2 — segunda cópia (Google Drive, decisão do operador). Estados só AVANÇAM com evidência:
 *   VALIDO_LOCAL → CIFRADO → ENVIADO → VERIFICADO_NUVEM
 * `VERIFICADO_NUVEM` exige: upload concluído + existência e tamanho remotos + DOWNLOAD de verificação + SHA-256 do
 * arquivo baixado igual ao do arquivo cifrado local. Resposta HTTP de upload NÃO é prova de integridade.
 *
 * O transporte do Google Drive NÃO está implementado nesta fase (sem mecanismo nem credencial autorizados): a fábrica
 * recusa. A máquina de estados é testada com transportes falsos.
 */

export const ESTADOS_SEGUNDA_COPIA = ["VALIDO_LOCAL", "CIFRADO", "ENVIADO", "VERIFICADO_NUVEM"] as const;
export type EstadoSegundaCopia = (typeof ESTADOS_SEGUNDA_COPIA)[number];

export interface RegistroSegundaCopia {
  base: string;
  estado: EstadoSegundaCopia;
  /** SHA-256 do archive PURO (do manifesto) — conferido de novo após decifrar, na recuperação. */
  sha256Original: string;
  arquivoCifrado: string | null;
  sha256Cifrado: string | null;
  tamanhoCifrado: number | null;
  idRemoto: string | null;
  tamanhoRemoto: number | null;
  sha256Baixado: string | null;
  historico: { estado: EstadoSegundaCopia; em: string; evidencia: string }[];
  falha: string | null;
}

export interface TransporteRemoto {
  readonly nome: string;
  enviar(caminhoLocal: string): Promise<{ idRemoto: string }>;
  consultar(idRemoto: string): Promise<{ existe: boolean; tamanho: number | null }>;
  baixar(idRemoto: string, destinoLocal: string): Promise<void>;
}

export class TransicaoInvalidaErro extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "TransicaoInvalidaErro";
  }
}

export function iniciarRegistro(base: string, sha256Original: string, agora: Date): RegistroSegundaCopia {
  return {
    base,
    estado: "VALIDO_LOCAL",
    sha256Original,
    arquivoCifrado: null,
    sha256Cifrado: null,
    tamanhoCifrado: null,
    idRemoto: null,
    tamanhoRemoto: null,
    sha256Baixado: null,
    historico: [{ estado: "VALIDO_LOCAL", em: agora.toISOString(), evidencia: "manifesto VALIDO_LOCAL" }],
    falha: null,
  };
}

function exigirEstado(r: RegistroSegundaCopia, esperado: EstadoSegundaCopia): void {
  if (r.estado !== esperado) throw new TransicaoInvalidaErro(`transição exige estado ${esperado}; atual ${r.estado}`);
}

/** VALIDO_LOCAL → CIFRADO: o arquivo cifrado existe, tem tamanho > 0 e o hash dele foi registrado. */
export function registrarCifrado(r: RegistroSegundaCopia, evidencia: { arquivoCifrado: string; sha256Cifrado: string; tamanhoCifrado: number }, agora: Date): RegistroSegundaCopia {
  exigirEstado(r, "VALIDO_LOCAL");
  if (!/^[0-9A-F]{64}$/.test(evidencia.sha256Cifrado) || evidencia.tamanhoCifrado <= 0) throw new TransicaoInvalidaErro("evidência de cifragem incompleta");
  return { ...r, ...evidencia, estado: "CIFRADO", historico: [...r.historico, { estado: "CIFRADO", em: agora.toISOString(), evidencia: `sha256=${evidencia.sha256Cifrado}` }] };
}

/** CIFRADO → ENVIADO: id remoto + existência + tamanho remoto IGUAL ao local. */
export function registrarEnviado(r: RegistroSegundaCopia, evidencia: { idRemoto: string; existe: boolean; tamanhoRemoto: number | null }, agora: Date): RegistroSegundaCopia {
  exigirEstado(r, "CIFRADO");
  if (!evidencia.idRemoto || !evidencia.existe) throw new TransicaoInvalidaErro("arquivo remoto inexistente após upload");
  if (evidencia.tamanhoRemoto !== r.tamanhoCifrado) throw new TransicaoInvalidaErro(`tamanho remoto (${evidencia.tamanhoRemoto}) difere do local (${r.tamanhoCifrado})`);
  return {
    ...r,
    idRemoto: evidencia.idRemoto,
    tamanhoRemoto: evidencia.tamanhoRemoto,
    estado: "ENVIADO",
    historico: [...r.historico, { estado: "ENVIADO", em: agora.toISOString(), evidencia: `tamanhoRemoto=${evidencia.tamanhoRemoto}` }],
  };
}

/** ENVIADO → VERIFICADO_NUVEM: SHA-256 do arquivo BAIXADO igual ao do cifrado local. */
export function registrarVerificado(r: RegistroSegundaCopia, evidencia: { sha256Baixado: string }, agora: Date): RegistroSegundaCopia {
  exigirEstado(r, "ENVIADO");
  if (evidencia.sha256Baixado !== r.sha256Cifrado) throw new TransicaoInvalidaErro("SHA-256 do arquivo baixado difere do cifrado local");
  return {
    ...r,
    sha256Baixado: evidencia.sha256Baixado,
    estado: "VERIFICADO_NUVEM",
    historico: [...r.historico, { estado: "VERIFICADO_NUVEM", em: agora.toISOString(), evidencia: "download de verificação com SHA-256 igual" }],
  };
}

/**
 * Executa ENVIADO e VERIFICADO_NUVEM a partir de um registro CIFRADO. Qualquer falha devolve o registro no ÚLTIMO
 * estado comprovado, com `falha` preenchida — nunca avança sem evidência.
 */
export async function enviarEVerificar(r: RegistroSegundaCopia, transporte: TransporteRemoto, caminhoDownload: string, agora: () => Date = () => new Date()): Promise<RegistroSegundaCopia> {
  let atual = r;
  try {
    exigirEstado(atual, "CIFRADO");
    const { idRemoto } = await transporte.enviar(atual.arquivoCifrado!);
    const consulta = await transporte.consultar(idRemoto);
    atual = registrarEnviado(atual, { idRemoto, existe: consulta.existe, tamanhoRemoto: consulta.tamanho }, agora());
    await transporte.baixar(idRemoto, caminhoDownload);
    if (statSync(caminhoDownload).size !== atual.tamanhoCifrado) throw new TransicaoInvalidaErro("tamanho do arquivo baixado difere do cifrado local");
    atual = registrarVerificado(atual, { sha256Baixado: await sha256DoArquivo(caminhoDownload) }, agora());
    return { ...atual, falha: null };
  } catch (erro) {
    return { ...atual, falha: erro instanceof Error ? erro.message.slice(0, 200) : "falha desconhecida" };
  }
}

/** Google Drive: decidido como fornecedor, mas SEM mecanismo nem credencial autorizados nesta fase. */
export function criarTransporteGoogleDrive(): TransporteRemoto {
  throw new TransicaoInvalidaErro(
    "BLOQUEADO: transporte Google Drive não implementado — falta decidir o mecanismo (API/OAuth ou cliente de sincronização com verificação por download) e autorizar a credencial",
  );
}
