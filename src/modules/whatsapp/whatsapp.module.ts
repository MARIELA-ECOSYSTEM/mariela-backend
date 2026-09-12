import { Module } from "@nestjs/common";
import { ClientesModule } from "../clientes/clientes.module.js";
import { FornecedoresModule } from "../fornecedores/fornecedores.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { EvolutionApiProvider } from "./providers/evolution-api.provider.js";
import { WHATSAPP_PROVIDER } from "./whatsapp.constants.js";
import { WhatsappController } from "./whatsapp.controller.js";
import { WhatsappService } from "./whatsapp.service.js";

/**
 * Importa Clientes/Fornecedores/Vendedores só para reaproveitar seus
 * repositórios já exportados (resolver telefone por id) — nenhuma regra
 * desses domínios é duplicada ou alterada aqui (Etapa Pré-22, §16-18/§20).
 */
@Module({
  imports: [ClientesModule, FornecedoresModule, VendedoresModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, { provide: WHATSAPP_PROVIDER, useClass: EvolutionApiProvider }],
  exports: [WhatsappService],
})
export class WhatsappModule {}
