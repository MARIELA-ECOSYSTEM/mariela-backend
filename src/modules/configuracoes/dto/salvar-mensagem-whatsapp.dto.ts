import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";
import { LIMITES_MENSAGEM_WHATSAPP } from "../configuracoes.constants.js";

/**
 * Fase 22.8.9.10.7.3 — criação/edição de uma mensagem padrão de WhatsApp: `{ titulo, conteudo }`, nada além disso
 * (`forbidNonWhitelisted`). Vazio só de espaços é recusado pelo service (que apara os dois campos).
 */
export class SalvarMensagemWhatsappDto {
  @ApiProperty({ example: "Pedido pronto para retirada", maxLength: LIMITES_MENSAGEM_WHATSAPP.titulo })
  @IsString()
  @MaxLength(LIMITES_MENSAGEM_WHATSAPP.titulo, { message: `O título pode ter no máximo ${LIMITES_MENSAGEM_WHATSAPP.titulo} caracteres.` })
  titulo!: string;

  @ApiProperty({ example: "Olá! Seu pedido já está pronto para retirada.", maxLength: LIMITES_MENSAGEM_WHATSAPP.conteudo })
  @IsString()
  @MaxLength(LIMITES_MENSAGEM_WHATSAPP.conteudo, { message: `A mensagem pode ter no máximo ${LIMITES_MENSAGEM_WHATSAPP.conteudo} caracteres.` })
  conteudo!: string;
}
