import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { ItemVendaPdvDto } from "./item-venda-pdv.dto.js";
import { PagamentoVendaPdvDto } from "./pagamento-venda-pdv.dto.js";

/**
 * Contrato de `POST /pdv/vendas` — espelha `DadosCriarVenda`
 * (`modules/vendas/vendas.types.ts`) MENOS `vendedorId` e `caixaId`: os dois
 * são resolvidos exclusivamente do contexto autenticado (`@VendedorPdv()`) e
 * do caixa aberto (`CaixasService.obterAtual()`), nunca aceitos do cliente —
 * como nenhum dos dois é declarado aqui, o `ValidationPipe` global
 * (`forbidNonWhitelisted: true`) já rejeita com 400 qualquer tentativa de
 * enviá-los no corpo, sem precisar de nenhuma checagem extra no controller/
 * service (ver `pdv-vendas.service.ts`).
 *
 * `idempotencyKey` é OBRIGATÓRIA aqui (diferente do uso interno/administrativo,
 * onde é opcional): toda venda real do PDV está sujeita a timeout/retry de
 * rede, então exigir a chave sempre é a defesa correta.
 */
export class CriarVendaPdvDto {
  @ApiProperty({ example: "3fa85f64-5717-4562-b3fc-2c963f66afa6", description: "Chave única gerada pelo cliente (UUID) — obrigatória para proteger contra retry duplicado." })
  @IsString()
  @IsNotEmpty({ message: "idempotencyKey é obrigatória." })
  idempotencyKey!: string;

  @ApiPropertyOptional({ nullable: true, description: "Id de um cliente já cadastrado. Ausente/null = Consumidor final." })
  @IsOptional()
  @IsString()
  clienteId?: string | null;

  @ApiProperty({ type: [ItemVendaPdvDto] })
  @IsArray()
  @ArrayMinSize(1, { message: "A venda precisa de ao menos um item." })
  @ValidateNested({ each: true })
  @Type(() => ItemVendaPdvDto)
  itens!: ItemVendaPdvDto[];

  @ApiPropertyOptional({ example: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "Informe um valor com até 2 casas decimais." })
  @Min(0, { message: "Desconto não pode ser negativo." })
  descontoVenda?: number;

  @ApiProperty({ type: [PagamentoVendaPdvDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PagamentoVendaPdvDto)
  pagamentos!: PagamentoVendaPdvDto[];

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  totalParcelas?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  observacao?: string;
}
