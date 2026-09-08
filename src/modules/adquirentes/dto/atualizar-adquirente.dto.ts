import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { TarifaConfigDto } from "./tarifa-config.dto.js";

/**
 * Diferente da maioria dos módulos administrativos (que usam `PUT` com
 * substituição completa via `AtualizarXDto extends CriarXDto`), este DTO é
 * genuinamente PARCIAL — todo campo é independentemente opcional e o service
 * só altera o que foi enviado (`PATCH /adquirentes/:id`, conforme contrato
 * desta etapa). Quando `tabelaTarifas` é enviada, ela SUBSTITUI a tabela
 * inteira (não faz merge item a item) e é revalidada por completo.
 */
export class AtualizarAdquirenteDto {
  @ApiPropertyOptional({ example: "Cielo", maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "Nome não pode ser vazio." })
  @MaxLength(120, { message: "Máximo de 120 caracteres." })
  nome?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  ativo?: boolean;

  @ApiPropertyOptional({ nullable: true, maxLength: 400 })
  @IsOptional()
  @IsString()
  @MaxLength(400, { message: "Máximo de 400 caracteres." })
  observacao?: string | null;

  @ApiPropertyOptional({ type: [TarifaConfigDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TarifaConfigDto)
  tabelaTarifas?: TarifaConfigDto[];
}
