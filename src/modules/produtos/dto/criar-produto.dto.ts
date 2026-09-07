import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from "class-validator";

/**
 * Espelha `ProdutoPayload` do Backoffice (`src/types/produto.ts`): o código,
 * a margem, a promoção e o estoque NUNCA fazem parte do payload — são
 * calculados/gerados pelo backend.
 */
export class CriarProdutoDto {
  @ApiProperty({ example: "Vestido Midi Amalfi", maxLength: 120 })
  @IsString()
  @IsNotEmpty({ message: "Nome é obrigatório." })
  @MaxLength(120, { message: "Máximo de 120 caracteres." })
  nome!: string;

  @ApiPropertyOptional({ example: "Vestido midi em viscose com decote V." })
  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: "Máximo de 1000 caracteres." })
  descricao?: string;

  @ApiProperty({ example: "Vestidos" })
  @IsString()
  @IsNotEmpty({ message: "Categoria é obrigatória." })
  categoria!: string;

  @ApiPropertyOptional({ example: "col_001", nullable: true })
  @IsOptional()
  @IsString()
  colecaoId?: string;

  @ApiPropertyOptional({ example: "cam_001", nullable: true })
  @IsOptional()
  @IsString()
  campanhaId?: string;

  @ApiPropertyOptional({ example: "for_001", nullable: true })
  @IsOptional()
  @IsString()
  fornecedorId?: string;

  @ApiProperty({ example: 89.9, minimum: 0.01 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe um valor com até 2 casas decimais." })
  @IsPositive({ message: "Preço de custo deve ser maior que zero." })
  precoCusto!: number;

  @ApiProperty({ example: 259.9, minimum: 0.01 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe um valor com até 2 casas decimais." })
  @IsPositive({ message: "Preço de venda deve ser maior que zero." })
  precoVenda!: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  ehNovidade?: boolean;
}
