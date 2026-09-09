import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

/** Contrato de `POST /configuracoes/:lista` (Etapa 11.2) — `{ "valor": "string" }`, nada além disso. */
export class AdicionarItemListaDto {
  @ApiProperty({ example: "Vestidos", maxLength: 60 })
  @IsString()
  @IsNotEmpty({ message: "O valor não pode ser vazio." })
  @MaxLength(60)
  valor!: string;
}
