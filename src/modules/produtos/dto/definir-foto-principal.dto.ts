import { ApiProperty } from "@nestjs/swagger";
import { IsMongoId, IsOptional } from "class-validator";

/** Espelha `FotoPrincipalRequest` (`src/types/produto.ts`). `null` = "usar a primeira foto cadastrada". */
export class DefinirFotoPrincipalDto {
  @ApiProperty({ example: "65f1a2b3c4d5e6f7a8b9c0d1", nullable: true })
  @IsOptional()
  @IsMongoId({ message: "Id de variante inválido." })
  varianteId!: string | null;
}
