import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ClientesModule } from "../clientes/clientes.module.js";
import { FornecedoresModule } from "../fornecedores/fornecedores.module.js";
import { VendedoresModule } from "../vendedores/vendedores.module.js";
import { BloqueiosWhatsappController } from "./bloqueios/bloqueios-whatsapp.controller.js";
import { BloqueiosWhatsappRepository } from "./bloqueios/bloqueios-whatsapp.repository.js";
import { BloqueiosWhatsappService } from "./bloqueios/bloqueios-whatsapp.service.js";
import { EnviosWhatsappController } from "./envios/envios-whatsapp.controller.js";
import { EnviosWhatsappService } from "./envios/envios-whatsapp.service.js";
import { MensagensWhatsappRepository } from "./envios/mensagens-whatsapp.repository.js";
import { EvolutionApiProvider } from "./providers/evolution-api.provider.js";
import { ProvedorEnvioDesativado } from "./providers/provedor-envio-desativado.js";
import { PROVEDOR_ENVIO_WHATSAPP } from "./providers/provedor-envio-whatsapp.interface.js";
import { BloqueioWhatsapp, BloqueioWhatsappSchema } from "./schemas/bloqueio-whatsapp.schema.js";
import { MensagemWhatsapp, MensagemWhatsappSchema } from "./schemas/mensagem-whatsapp.schema.js";
import { TemplatesWhatsappService } from "./templates/templates-whatsapp.service.js";
import { WHATSAPP_PROVIDER } from "./whatsapp.constants.js";
import { WhatsappController } from "./whatsapp.controller.js";
import { WhatsappService } from "./whatsapp.service.js";

/**
 * Importa Clientes/Fornecedores/Vendedores só para reaproveitar seus
 * repositórios já exportados (resolver telefone por id) — nenhuma regra
 * desses domínios é duplicada ou alterada aqui (Etapa Pré-22, §16-18/§20).
 *
 * Fase 22.8.9.10.3 — estrutura do envio por TEMPLATE (Cloud API): mensagens persistidas, idempotência, bloqueios e
 * catálogo de templates. O provedor de envio por template é o DESATIVADO (nunca faz chamada de rede) até a Fase
 * 22.8.9.10.4; o fluxo da Evolution (`WhatsappController`/`WhatsappService`) segue intacto durante a transição.
 */
@Module({
  imports: [
    ClientesModule,
    FornecedoresModule,
    VendedoresModule,
    MongooseModule.forFeature([
      { name: MensagemWhatsapp.name, schema: MensagemWhatsappSchema },
      { name: BloqueioWhatsapp.name, schema: BloqueioWhatsappSchema },
    ]),
  ],
  controllers: [WhatsappController, EnviosWhatsappController, BloqueiosWhatsappController],
  providers: [
    WhatsappService,
    { provide: WHATSAPP_PROVIDER, useClass: EvolutionApiProvider },
    MensagensWhatsappRepository,
    BloqueiosWhatsappRepository,
    BloqueiosWhatsappService,
    TemplatesWhatsappService,
    EnviosWhatsappService,
    { provide: PROVEDOR_ENVIO_WHATSAPP, useClass: ProvedorEnvioDesativado },
  ],
  exports: [WhatsappService],
})
export class WhatsappModule {}
