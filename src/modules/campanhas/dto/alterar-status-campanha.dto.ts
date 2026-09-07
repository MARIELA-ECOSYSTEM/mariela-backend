import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean } from "class-validator";

/** Espelha `StatusPayload` do Backoffice, reaproveitado por Coleções/Campanhas. */
export class AlterarStatusCampanhaDto {
  @ApiProperty({ example: true })
  @Type(() => Boolean)
  @IsBoolean()
  ativo!: boolean;
}
