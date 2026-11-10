import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsMongoId, IsNotEmpty, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";

/** Espelha `EntradaEstoqueRequest` (`src/types/estoque.ts`). */
export class EntradaEstoqueDto {
  @ApiProperty()
  @IsMongoId({ message: "Id de produto inválido." })
  produtoId!: string;

  @ApiProperty()
  @IsMongoId({ message: "Id de variante inválido." })
  varianteId!: string;

  @ApiPropertyOptional({ description: "Informe para somar em um tamanho já existente." })
  @IsOptional()
  @IsMongoId({ message: "Id de tamanho inválido." })
  tamanhoId?: string;

  @ApiPropertyOptional({ description: "Informe para criar um novo tamanho na variante." })
  @IsOptional()
  @IsString()
  tamanho?: string;

  @ApiProperty({ example: 5, minimum: 1 })
  @Type(() => Number)
  @IsInt({ message: "Use números inteiros." })
  @IsPositive({ message: "Quantidade deve ser maior que zero." })
  quantidade!: number;

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
