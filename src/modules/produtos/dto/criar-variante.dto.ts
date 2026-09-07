import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from "class-validator";

/**
 * Espelha `CriarVarianteRequest` (`src/types/variante.ts`): `codVariante`
 * nunca é aceito do cliente — é derivado do código do produto + cor. Usada
 * tanto para criar quanto para atualizar (o Backoffice reusa o mesmo formato).
 */
export class CriarVarianteDto {
  @ApiProperty({ example: "Preto" })
  @IsString()
  @IsNotEmpty({ message: "Cor é obrigatória." })
  cor!: string;

  @ApiPropertyOptional({ example: "https://cdn.mariela.com/produtos/prod-0001-preto.jpg", nullable: true })
  @IsOptional()
  @IsUrl({}, { message: "Informe uma URL válida." })
  @MaxLength(500)
  foto?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUrl({}, { message: "Informe uma URL válida." })
  @MaxLength(500)
  video?: string | null;
}
