import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import {
  ESTADOS_MENSAGEM_WHATSAPP,
  LIMITE_MAXIMO_WHATSAPP,
  LIMITE_PADRAO_WHATSAPP,
  PAGINA_PADRAO_WHATSAPP,
  TIPOS_CAMPANHA_WHATSAPP,
  TIPOS_DESTINATARIO_ENVIO_WHATSAPP,
  type EstadoMensagemWhatsapp,
  type TipoCampanhaWhatsapp,
  type TipoDestinatarioEnvioWhatsapp,
} from "../envios/envios-whatsapp.constants.js";

/**
 * Fase 22.8.9.10.3 — DTOs do envio por template. Deliberadamente SEM telefone, SEM texto e SEM valores de parâmetros:
 * o destinatário é resolvido do cadastro e os parâmetros são derivados no backend (`forbidNonWhitelisted` recusa
 * qualquer campo extra, inclusive dentro dos objetos aninhados).
 */
export class DestinatarioEnvioWhatsappDto {
  @ApiProperty({ enum: TIPOS_DESTINATARIO_ENVIO_WHATSAPP, example: "CLIENTE" })
  @IsIn(TIPOS_DESTINATARIO_ENVIO_WHATSAPP, { message: "tipo deve ser CLIENTE." })
  tipo!: TipoDestinatarioEnvioWhatsapp;

  @ApiProperty({ example: "65f1a2b3c4d5e6f7a8b9c0d1" })
  @IsMongoId({ message: "id deve ser um identificador válido." })
  id!: string;
}

export class CampanhaEnvioWhatsappDto {
  @ApiProperty({ enum: TIPOS_CAMPANHA_WHATSAPP, example: "ANIVERSARIO" })
  @IsIn(TIPOS_CAMPANHA_WHATSAPP, { message: "tipo de campanha inválido." })
  tipo!: TipoCampanhaWhatsapp;
}

export class EnviarTemplateWhatsappDto {
  @ApiProperty({ description: "UUID v4 gerado pelo Backoffice — um por destinatário e por mensagem." })
  @IsUUID("4", { message: "idempotencyKey deve ser um UUID v4." })
  idempotencyKey!: string;

  @ApiProperty({ type: DestinatarioEnvioWhatsappDto })
  @IsDefined({ message: "destinatario é obrigatório." })
  @ValidateNested()
  @Type(() => DestinatarioEnvioWhatsappDto)
  destinatario!: DestinatarioEnvioWhatsappDto;

  @ApiProperty({ example: "aniversario_v2", description: "Chave interna do catálogo de templates." })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  template!: string;

  @ApiPropertyOptional({ type: CampanhaEnvioWhatsappDto, description: "Só para envio de campanha. O ano é o ano civil do envio (servidor)." })
  @IsOptional()
  @ValidateNested()
  @Type(() => CampanhaEnvioWhatsappDto)
  campanha?: CampanhaEnvioWhatsappDto;
}

export class ListarMensagensWhatsappQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId({ message: "clienteId deve ser um identificador válido." })
  clienteId?: string;

  @ApiPropertyOptional({ enum: ESTADOS_MENSAGEM_WHATSAPP })
  @IsOptional()
  @IsIn(ESTADOS_MENSAGEM_WHATSAPP)
  estado?: EstadoMensagemWhatsapp;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(9999)
  campanhaAno?: number;

  @ApiPropertyOptional({ default: PAGINA_PADRAO_WHATSAPP, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = PAGINA_PADRAO_WHATSAPP;

  @ApiPropertyOptional({ default: LIMITE_PADRAO_WHATSAPP, minimum: 1, maximum: LIMITE_MAXIMO_WHATSAPP })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO_WHATSAPP)
  limit: number = LIMITE_PADRAO_WHATSAPP;
}

export class LiberarReenvioWhatsappDto {
  @ApiProperty({ minLength: 10, maxLength: 300 })
  @IsString()
  @MinLength(10, { message: "Descreva o motivo (mínimo de 10 caracteres)." })
  @MaxLength(300)
  motivo!: string;

  @ApiPropertyOptional({ description: "Obrigatório (true) para mensagem indeterminada: o reenvio pode duplicar a mensagem." })
  @IsOptional()
  @IsBoolean()
  confirmoRiscoDeDuplicidade?: boolean;
}

export class PreviaTemplateWhatsappDto {
  @ApiProperty({ example: "65f1a2b3c4d5e6f7a8b9c0d1" })
  @IsMongoId({ message: "clienteId deve ser um identificador válido." })
  clienteId!: string;
}

export class BloquearContatoWhatsappDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  motivo?: string;
}

export class DesbloquearContatoWhatsappDto {
  @ApiProperty({ minLength: 3, maxLength: 200, description: "Desbloquear reverte um pedido de não contato: motivo obrigatório." })
  @IsString()
  @MinLength(3, { message: "Informe o motivo do desbloqueio." })
  @MaxLength(200)
  motivo!: string;
}

export class ListarBloqueiosWhatsappQueryDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => String)
  @IsIn(["true", "false"])
  somenteAtivos?: "true" | "false";

  @ApiPropertyOptional({ default: PAGINA_PADRAO_WHATSAPP, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = PAGINA_PADRAO_WHATSAPP;

  @ApiPropertyOptional({ default: LIMITE_PADRAO_WHATSAPP, minimum: 1, maximum: LIMITE_MAXIMO_WHATSAPP })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIMITE_MAXIMO_WHATSAPP)
  limit: number = LIMITE_PADRAO_WHATSAPP;
}
