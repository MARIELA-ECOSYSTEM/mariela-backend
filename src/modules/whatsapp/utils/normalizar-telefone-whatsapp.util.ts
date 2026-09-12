import { ApiException } from "../../../common/exceptions/api.exception.js";
import { TELEFONE_DIGITOS_VALIDOS } from "../whatsapp.constants.js";

/**
 * Converte um telefone brasileiro (com ou sem máscara, com ou sem DDI) para o
 * formato E.164 exigido pelo envio de WhatsApp (`+55DDDNNNNNNNNN`).
 *
 * Distinto de propósito do `normalizarTelefone` de Clientes/Fornecedores/
 * Vendedores: aquele só extrai dígitos para COMPARAR telefones (unicidade de
 * cadastro) e nunca produz um número pronto para discagem. Este utilitário é
 * o único ponto do backend que decide o formato enviado à Evolution API —
 * nenhum outro módulo deve montar esse formato por conta própria.
 *
 * Nunca corrige silenciosamente um número ambíguo: comprimento fora de
 * DDD+10 ou DDD+11 dígitos é erro de validação, não uma tentativa de adivinhar
 * a intenção do cadastro.
 */
export function normalizarTelefoneParaWhatsapp(telefone: string): string {
  const digitos = telefone.replace(/\D/g, "");
  const semDdiBrasil = digitos.startsWith("55") && digitos.length > 11 ? digitos.slice(2) : digitos;

  if (!TELEFONE_DIGITOS_VALIDOS.includes(semDdiBrasil.length)) {
    throw ApiException.whatsappInvalidNumber("O telefone cadastrado não é válido para envio de WhatsApp.", [
      { field: "telefone", message: "Informe DDD + número (10 ou 11 dígitos)." },
    ]);
  }

  return `+55${semDdiBrasil}`;
}
