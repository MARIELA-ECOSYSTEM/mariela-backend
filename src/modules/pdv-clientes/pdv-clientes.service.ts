import { Injectable } from "@nestjs/common";
import type { ApiMeta } from "../../common/types/api-response.interface.js";
import { ClientesService } from "../clientes/clientes.service.js";
import type { ListarClientesQueryDto } from "../clientes/dto/listar-clientes-query.dto.js";
import type { ClienteDocument } from "../clientes/schemas/cliente.schema.js";
import type { ListarClientesPdvQueryDto } from "./dto/listar-clientes-pdv-query.dto.js";
import type { ClientePdv } from "./pdv-clientes.types.js";

export interface ResultadoListaClientesPdv {
  data: ClientePdv[];
  meta: ApiMeta;
}

/**
 * Camada de ADAPTAÇÃO/ORQUESTRAÇÃO entre o MARIELA PDV e o domínio de
 * Clientes — NÃO é uma segunda implementação. Toda regra (busca, paginação,
 * ordenação) continua inteiramente em `ClientesService`/`ClientesRepository`/
 * `clientes-filtros.util.ts`; este service só delega e projeta o resultado
 * para o formato do PDV (`ClientePdv`), removendo campos administrativos.
 *
 * Só leitura: nenhum método de criação/atualização/exclusão — o cadastro de
 * clientes continua exclusivo do Backoffice (`POST/PUT/DELETE /clientes`).
 */
@Injectable()
export class PdvClientesService {
  constructor(private readonly clientesService: ClientesService) {}

  async listar(query: ListarClientesPdvQueryDto): Promise<ResultadoListaClientesPdv> {
    // Mapeia para o DTO administrativo completo (facetas sempre vazias, ordem
    // sempre nome/asc — o PDV não expõe filtro de gestão) e delega
    // inteiramente a `ClientesService.listar`, a MESMA busca/paginação já
    // usada pelo Backoffice — nunca uma segunda implementação.
    const queryAdmin: ListarClientesQueryDto = {
      busca: query.busca,
      ordenarPor: "nome",
      ordem: "asc",
      recencia: [],
      historico: [],
      aniversario: [],
      observacao: [],
      page: query.page,
      limit: query.limit,
    };

    const { data, meta } = await this.clientesService.listar(queryAdmin);
    return { data: data.map((cliente) => this.paraClientePdv(cliente)), meta };
  }

  private paraClientePdv(cliente: ClienteDocument): ClientePdv {
    return {
      id: cliente.id,
      codigo: cliente.codigo,
      nome: cliente.nome,
      foto: cliente.foto,
      telefone: cliente.telefone,
    };
  }
}
