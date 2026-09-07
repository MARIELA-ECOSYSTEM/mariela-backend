import { CriarVendedorDto } from "./criar-vendedor.dto.js";

/**
 * O Backoffice sempre envia o payload completo em `PUT /vendedores/:id` (não é
 * uma atualização parcial) — por isso o mesmo formato de `CriarVendedorDto`.
 * `senha` continua opcional aqui: presente = redefine, ausente = mantém.
 */
export class AtualizarVendedorDto extends CriarVendedorDto {}
