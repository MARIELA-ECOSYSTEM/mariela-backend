import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from "class-validator";
import { TarifaConfigDto } from "./tarifa-config.dto.js";

/**
 * `tabelaTarifas` é opcional na criação — é permitido cadastrar a adquirente
 * primeiro e configurar as tarifas depois (seção 9 do pedido). Nenhum campo
 * de negócio (aplicação de tarifa em venda) faz parte deste DTO — isso é
 * responsabilidade de uma etapa futura.
 */
export class CriarAdquirenteDto {
  @ApiProperty({ example: "Cielo", maxLength: 120 })
  @IsString()
  @IsNotEmpty({ message: "Nome é obrigatório." })
  @MaxLength(120, { message: "Máximo de 120 caracteres." })
  nome!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  ativo?: boolean;

  @ApiPropertyOptional({ example: "Recebimento D+1", nullable: true, maxLength: 400 })
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
