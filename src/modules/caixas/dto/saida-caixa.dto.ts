import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import { EntradaCaixaDto } from "./entrada-caixa.dto.js";

/** Espelha `SaidaCaixaPayload` (`src/types/caixa.ts`): tudo de `EntradaCaixaDto` + motivo obrigatório. */
export class SaidaCaixaDto extends EntradaCaixaDto {
  @ApiProperty({ example: "Compra de material de limpeza" })
  @IsString()
  @IsNotEmpty({ message: "Informe o motivo da saída." })
  @MaxLength(200)
  motivo!: string;
}
