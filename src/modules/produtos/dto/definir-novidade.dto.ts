import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean } from "class-validator";

/** Espelha `NovidadeRequest` (`src/types/produto.ts`). */
export class DefinirNovidadeDto {
  @ApiProperty({ example: true })
  @Type(() => Boolean)
  @IsBoolean()
  ehNovidade!: boolean;
}
