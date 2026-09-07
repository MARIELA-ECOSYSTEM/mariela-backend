import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Espelha `ColecaoPayload` do Backoffice (`src/types/colecao.ts`): o código
 * e os agregados de produtos (`produtosVinculados`) NUNCA fazem parte do
 * payload — são gerados/calculados pelo backend. A validação `fim >= inicio`
 * acontece no service (é uma regra cruzando dois campos, não um formato de
 * campo isolado — mesmo critério já usado em Produtos para preço/promoção).
 */
export class CriarColecaoDto {
  @ApiProperty({ example: "Verão 2026", maxLength: 120 })
  @IsString()
  @IsNotEmpty({ message: "Nome é obrigatório." })
  @MaxLength(120, { message: "Máximo de 120 caracteres." })
  nome!: string;

  @ApiPropertyOptional({ example: "Peças leves para a estação." })
  @IsOptional()
  @IsString()
  @MaxLength(400, { message: "Máximo de 400 caracteres." })
  descricao?: string;

  @ApiProperty({ example: "2026-01-01", description: "Data em ISO (YYYY-MM-DD)." })
  @IsDateString({}, { message: "Data de início inválida." })
  inicio!: string;

  @ApiProperty({ example: "2026-03-31", description: "Data em ISO (YYYY-MM-DD)." })
  @IsDateString({}, { message: "Data de fim inválida." })
  fim!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  ativo?: boolean;

  @ApiPropertyOptional({ default: false, description: "Aparece em áreas de destaque da vitrine." })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  destaque?: boolean;

  @ApiPropertyOptional({ default: false, description: "Aparece em banners/hero sections da vitrine." })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  banner?: boolean;

  @ApiPropertyOptional({ example: "https://…", maxLength: 600 })
  @IsOptional()
  @IsString()
  @MaxLength(600, { message: "Máximo de 600 caracteres." })
  fotoDestaque?: string;

  @ApiPropertyOptional({ example: "https://…", maxLength: 600 })
  @IsOptional()
  @IsString()
  @MaxLength(600, { message: "Máximo de 600 caracteres." })
  fotoBanner?: string;
}
