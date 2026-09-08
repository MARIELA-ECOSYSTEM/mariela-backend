import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { DescontoDto } from "./desconto-pdv.dto.js";

/**
 * Espelha `ItemVendaSolicitado` (`modules/vendas/vendas.types.ts`) — o PDV só
 * declara A INTENÇÃO (o quê, qual variante, qual tamanho, quantas peças e,
 * opcionalmente, o desconto desejado nesta linha). Preço, subtotal e
 * snapshot são SEMPRE resolvidos por `VendasService.criar` a partir do
 * produto real no banco — nunca aceitos aqui. O desconto por item incide
 * sempre sobre o preço PRATICADO (já com promoção), nunca sobre o de
 * tabela — resolvido e validado inteiramente no service, nunca aqui.
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

  @ApiPropertyOptional({ type: DescontoDto, description: "Desconto sobre o preço praticado desta linha (após promoção)." })
  @IsOptional()
  @ValidateNested()
  @Type(() => DescontoDto)
  desconto?: DescontoDto;
}
