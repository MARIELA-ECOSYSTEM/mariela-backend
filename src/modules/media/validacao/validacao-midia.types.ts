/**
 * Fase 60.4.3.4.1 — resultado da validação de conteúdo de uma mídia. `motivo` é estável (mapeado para a mensagem
 * pública em `MENSAGEM_DE_RECUSA`); `detalhe` é técnico e só vai para o log do servidor, nunca para o cliente.
 */
export const MOTIVOS_DE_RECUSA = ["estrutura", "decodificacao", "formato", "dimensoes", "quadros", "animacao", "duracao", "codec", "dados-extras"] as const;
export type MotivoRecusa = (typeof MOTIVOS_DE_RECUSA)[number];

export type ResultadoValidacao =
  | { valido: true; formato: string; largura: number; altura: number; quadros?: number; duracaoSegundos?: number }
  | { valido: false; motivo: MotivoRecusa; detalhe: string };

/** Mensagens públicas (400 `VALIDATION_ERROR`, campo `arquivo`). Sem detalhe interno do parser ou do decodificador. */
export const MENSAGEM_DE_RECUSA: Record<MotivoRecusa, string> = {
  estrutura: "O arquivo está corrompido ou incompleto.",
  decodificacao: "O arquivo está corrompido ou incompleto.",
  formato: "O conteúdo do arquivo não corresponde ao formato declarado.",
  dimensoes: "A mídia excede o limite de 25 megapixels (ou 16.383 pixels de lado).",
  quadros: "GIFs com mais de 100 quadros não são permitidos.",
  animacao: "PNG animado (APNG) e WebP animado não são permitidos.",
  duracao: "O vídeo excede a duração máxima de 30 segundos.",
  codec: "Codec não permitido: use vídeo H.264, com áudio AAC opcional.",
  "dados-extras": "O arquivo contém dados adicionais não reconhecidos após o fim do conteúdo.",
};

/** Recusa de conteúdo: lançada pelos parsers e convertida em `ResultadoValidacao` pelo orquestrador. */
export class RecusaDeMidia extends Error {
  constructor(
    readonly motivo: MotivoRecusa,
    readonly detalhe: string,
  ) {
    super(detalhe);
    this.name = "RecusaDeMidia";
  }
}

export function ehResultadoValidacao(valor: unknown): valor is ResultadoValidacao {
  if (typeof valor !== "object" || valor === null || !("valido" in valor)) return false;
  if (valor.valido === true) {
    return "formato" in valor && typeof valor.formato === "string" && "largura" in valor && typeof valor.largura === "number" && "altura" in valor && typeof valor.altura === "number";
  }
  return (
    valor.valido === false &&
    "motivo" in valor &&
    typeof valor.motivo === "string" &&
    MOTIVOS_DE_RECUSA.some((motivo) => motivo === valor.motivo) &&
    "detalhe" in valor &&
    typeof valor.detalhe === "string"
  );
}
