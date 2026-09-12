import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsMongoId, IsOptional, IsString, MaxLength } from "class-validator";
import { TIPOS_DESTINATARIO_WHATSAPP, type TipoDestinatarioWhatsapp } from "../whatsapp.types.js";

/**
 * Contrato de `POST /integracoes/whatsapp/mensagens`. Deliberadamente SEM
 * `telefone`: o destinatário é sempre resolvido pelo backend a partir de
 * `tipo`+`id` (Etapa Pré-22, §6/§15/§16-18) — nunca aceito como autoridade
 * vindo do frontend. `mensagem` é opcional: quando ausente, o backend aplica
 * o template padrão do `tipo` (ver `templates/`); quando presente, é o texto
 * já composto/editado pelo administrador na tela (comportamento existente,
 * preservado).
 */
export class EnviarMensagemWhatsappDto {
  @ApiProperty({ enum: TIPOS_DESTINATARIO_WHATSAPP, example: "CLIENTE" })
  @IsIn(TIPOS_DESTINATARIO_WHATSAPP, { message: "tipo deve ser CLIENTE, FORNECEDOR ou VENDEDOR." })
  tipo!: TipoDestinatarioWhatsapp;

  @ApiProperty({ example: "65f1a2b3c4d5e6f7a8b9c0d1" })
  @IsMongoId({ message: "id deve ser um identificador válido." })
  id!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: "Máximo de 1000 caracteres." })
  mensagem?: string;
}
