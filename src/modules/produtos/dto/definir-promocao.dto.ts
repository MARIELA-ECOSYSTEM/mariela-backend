import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsNumber, IsPositive, ValidateIf } from "class-validator";

/** Espelha `PromocaoRequest` (`src/types/produto.ts`). */
export class DefinirPromocaoDto {
  @ApiProperty({ example: true })
  @Type(() => Boolean)
  @IsBoolean()
  ehPromocao!: boolean;

  @ApiPropertyOptional({ example: 199.9, description: "Obrigatório quando `ehPromocao` é `true`." })
  @ValidateIf((dto: DefinirPromocaoDto) => dto.ehPromocao)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe um valor com até 2 casas decimais." })
  @IsPositive({ message: "Preço promocional deve ser maior que zero." })
  precoPromocional?: number;
}
