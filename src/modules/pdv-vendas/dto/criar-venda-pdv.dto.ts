import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { plainToInstance, Transform, Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { DescontoDto } from "./desconto-pdv.dto.js";
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

  /**
   * Desconto sobre o subtotal da venda (já com os descontos de item
   * aplicados). Retrocompatibilidade: um número puro (`20`) é normalizado
   * aqui mesmo, ANTES da validação, para `{ tipo: "valor", valor: 20 }` — o
   * formato novo `{ tipo, valor }` também é aceito diretamente. Os limites
   * que dependem do subtotal (percentual ≤ 100%, valor ≤ subtotal) são
   * responsabilidade do service, não deste DTO (ver `desconto-pdv.dto.ts`).
   *
   * A instanciação de `DescontoDto` é feita AQUI DENTRO do `@Transform` (via
   * `plainToInstance`), em vez do par usual `@ValidateNested()` + `@Type()`:
   * como o valor de entrada pode ser um `number` OU um objeto, o `@Type()`
   * rodaria antes da normalização e nunca veria o objeto já normalizado —
   * `@Transform` fazendo as duas coisas (normalizar e instanciar) numa única
   * etapa evita essa corrida entre os dois mecanismos do `class-transformer`.
   */
  @ApiPropertyOptional({
    description: "Desconto sobre o subtotal da venda. Um número puro é interpretado como valor absoluto em R$ (retrocompatibilidade).",
    oneOf: [{ type: "number", example: 20 }, { $ref: "#/components/schemas/DescontoDto" }],
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) return value;
    const bruto = typeof value === "number" ? { tipo: "valor", valor: value } : value;
    return plainToInstance(DescontoDto, bruto);
  })
  @ValidateNested()
  descontoVenda?: DescontoDto;

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
