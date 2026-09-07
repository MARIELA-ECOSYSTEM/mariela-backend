import { CriarClienteDto } from "./criar-cliente.dto.js";

/**
 * O Backoffice sempre envia o payload completo em `PUT /clientes/:id` (não é
 * uma atualização parcial) — por isso o mesmo formato de `CriarClienteDto`, e
 * não um `PartialType`. O código do cliente continua imutável (nem faz parte
 * deste DTO).
 */
export class AtualizarClienteDto extends CriarClienteDto {}
