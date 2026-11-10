import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsMongoId, IsNotEmpty, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";

/** Espelha `SaidaEstoqueRequest` (`src/types/estoque.ts`). */
export class SaidaEstoqueDto {
  @ApiProperty()
  @IsMongoId({ message: "Id de produto inválido." })
  produtoId!: string;

  @ApiProperty()
  @IsMongoId({ message: "Id de variante inválido." })
  varianteId!: string;

  @ApiProperty()
  @IsMongoId({ message: "Id de tamanho inválido." })
  tamanhoId!: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @Type(() => Number)
  @IsInt({ message: "Use números inteiros." })
  @IsPositive({ message: "Quantidade deve ser maior que zero." })
  quantidade!: number;

  @ApiProperty({ example: "Peça avariada" })
  @IsString()
  @IsNotEmpty({ message: "Motivo é obrigatório." })
  @MaxLength(200, { message: "Máximo de 200 caracteres." })
  motivo!: string;

  @ApiPropertyOptional({
    description:
      "Fase 22.1 — chave de idempotência opcional. Repetir a MESMA chave com o MESMO conteúdo não lança de novo; com conteúdo diferente responde 409.",
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "idempotencyKey não pode ser vazia quando informada." })
  @MaxLength(120, { message: "Máximo de 120 caracteres." })
  idempotencyKey?: string;
}
