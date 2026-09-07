import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsString, Min } from "class-validator";

/** Espelha `AdicionarTamanhoRequest` (`src/types/variante.ts`). */
export class AdicionarTamanhoDto {
  @ApiProperty({ example: "M" })
  @IsString()
  @IsNotEmpty({ message: "Tamanho é obrigatório." })
  tamanho!: string;

  @ApiProperty({ example: 10, minimum: 0 })
  @Type(() => Number)
  @IsInt({ message: "Use números inteiros." })
  @Min(0, { message: "Quantidade deve ser maior ou igual a zero." })
  quantidade!: number;
}
