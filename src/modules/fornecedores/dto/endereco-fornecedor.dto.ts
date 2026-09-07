import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

/** Endereço 100% opcional — nenhum campo é obrigatório (mesmo contrato do frontend). */
export class EnderecoFornecedorDto {
  @ApiPropertyOptional({ example: "01310-100", maxLength: 12 })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  cep?: string;

  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  logradouro?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  numero?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  complemento?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  bairro?: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  cidade?: string;

  @ApiPropertyOptional({ example: "SP", maxLength: 2 })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  estado?: string;
}
