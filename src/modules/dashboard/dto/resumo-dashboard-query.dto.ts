import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

/**
 * Espelha o contrato já documentado em `src/types/dashboard.ts`:
 * `GET /dashboard/resumo?mes=YYYY-MM`. Não valida o formato rigidamente —
 * um valor fora dos últimos `MESES_DISPONIVEIS` simplesmente cai no mês
 * atual (mesmo comportamento do mock), então uma validação de formato aqui
 * só duplicaria essa mesma checagem sem trazer benefício real.
 */
export class ResumoDashboardQueryDto {
  @ApiPropertyOptional({ example: "2026-08", description: "Mês de referência (YYYY-MM). Fora do intervalo disponível = mês atual." })
  @IsOptional()
  @IsString()
  mes?: string;
}
