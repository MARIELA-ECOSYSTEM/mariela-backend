import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean } from "class-validator";

/** Espelha `StatusPayload` do Backoffice (`src/types/fornecedor.ts`, reaproveitado por Coleções/Campanhas). */
export class AlterarStatusColecaoDto {
  @ApiProperty({ example: true })
  @Type(() => Boolean)
  @IsBoolean()
  ativo!: boolean;
}
