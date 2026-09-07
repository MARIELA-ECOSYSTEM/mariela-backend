import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsString, Min } from "class-validator";

/**
 * Espelha `ItemVendaSolicitado` (`modules/vendas/vendas.types.ts`) — o PDV só
 * declara A INTENÇÃO (o quê, qual variante, qual tamanho, quantas peças).
 * Preço, subtotal e snapshot são SEMPRE resolvidos por `VendasService.criar`
 * a partir do produto real no banco — nunca aceitos aqui.
 */
export class ItemVendaPdvDto {
  @ApiProperty({ description: "Id do produto." })
  @IsString()
  @IsNotEmpty({ message: "Produto é obrigatório." })
  produtoId!: string;

  @ApiProperty({ description: "Id da variante (cor) do produto." })
  @IsString()
  @IsNotEmpty({ message: "Variante é obrigatória." })
  varianteId!: string;

  @ApiProperty({ description: "Id do tamanho dentro da variante." })
  @IsString()
  @IsNotEmpty({ message: "Tamanho é obrigatório." })
  tamanhoId!: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt({ message: "Quantidade deve ser um número inteiro." })
  @Min(1, { message: "Quantidade deve ser maior que zero." })
  quantidade!: number;
}
