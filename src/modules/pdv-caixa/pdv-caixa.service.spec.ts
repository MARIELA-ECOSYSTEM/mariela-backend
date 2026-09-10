import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test, type TestingModule } from "@nestjs/testing";
import { Types, type Connection } from "mongoose";
import configuration from "../../config/configuration.js";
import { validateEnv } from "../../config/env.validation.js";
import { ApiException } from "../../common/exceptions/api.exception.js";
import { mongooseModuloDeTeste } from "../../test-utils/mongo-teste.util.js";
import { CaixasService } from "../caixas/caixas.service.js";
import type { CriarVendedorDto } from "../vendedores/dto/criar-vendedor.dto.js";
import { VendedoresService } from "../vendedores/vendedores.service.js";
import { PdvCaixaModule } from "./pdv-caixa.module.js";
import { PdvCaixaService } from "./pdv-caixa.service.js";

let contador = 0;
function sufixo(): string {
  contador += 1;
  return String(contador);
}

// `VendedoresController`/`CaixasController` (importados transitivamente) usam
// `JwtAuthGuard` do ADMIN via `@UseGuards`, que precisa de um `JwtService`
// GLOBAL para resolver — nada a ver com a autenticação do PDV em si.
const JWT_ADMIN_MODULO_DE_TESTE = JwtModule.register({
  global: true,
  secret: "segredo-admin-de-teste",
  signOptions: { expiresIn: "15m" },
});

describe("PdvCaixaService (integração — MongoDB real)", () => {
  let moduleRef: TestingModule;
  let service: PdvCaixaService;
  let caixasService: CaixasService;
  let vendedoresService: VendedoresService;
  let connection: Connection;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        mongooseModuloDeTeste(),
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
        JWT_ADMIN_MODULO_DE_TESTE,
        PdvCaixaModule,
      ],
    }).compile();
    service = moduleRef.get(PdvCaixaService);
    caixasService = moduleRef.get(CaixasService);
    vendedoresService = moduleRef.get(VendedoresService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterAll(async () => {
    await connection.collection("caixas").deleteMany({});
    await connection.collection("movimentos_caixa").deleteMany({});
    await connection.collection("eventos_caixa").deleteMany({});
    await connection.collection("vendedores").deleteMany({});
    await connection.collection("eventos_vendedor").deleteMany({});
    await connection.collection("sequencias").deleteMany({ _id: { $in: ["caixa", "vendedor"] } });
    await moduleRef.close();
  });

  async function criarVendedor(): Promise<{ id: string; codigo: string; nome: string }> {
    const s = sufixo();
    const dto: CriarVendedorDto = { nome: `Vendedor PDV Caixa ${s}`, telefone: `1194${String(contador).padStart(6, "0")}`, ativo: true, senha: "senha123" };
    const vendedor = await vendedoresService.criar(dto, null);
    return { id: vendedor.id, codigo: vendedor.codigo, nome: vendedor.nome };
  }

  async function fecharSeAberto(): Promise<void> {
    const atual = await caixasService.obterAtual();
    if (atual) await caixasService.fechar(atual.id, { valorInformado: atual.resumo.saldoEsperado }, null);
  }

  describe("atual", () => {
    it("sem nenhum caixa aberto, devolve null (nunca um erro)", async () => {
      await fecharSeAberto();
      const resultado = await service.atual();
      expect(resultado).toBeNull();
    });

    it("com um caixa aberto, devolve exatamente o mesmo resultado de CaixasService.obterAtual", async () => {
      await fecharSeAberto();
      const vendedor = await criarVendedor();
      await service.abrir(vendedor.id, { valorInicial: 100 });

      const viaService = await service.atual();
      const viaCaixasService = await caixasService.obterAtual();
      expect(viaService).toEqual(viaCaixasService);

      await fecharSeAberto();
    });
  });

  describe("abrir", () => {
    /**
     * Etapa 18.2 — o Caixa Geral da Loja NÃO tem mais vínculo de vendedor: o
     * vendedor autenticado pelo PDV identifica só o AUTOR do evento de
     * auditoria `caixa.aberto`, nunca é persistido no documento financeiro.
     * `abertura.responsavelNome` volta sempre `"Loja"` (placeholder fixo de
     * compatibilidade de contrato, ver `CaixasService.paraRespostaPublica`),
     * independente de QUAL vendedor abriu.
     */
    it("o vendedor autenticado NUNCA é persistido no Caixa — só identifica o autor do evento de auditoria", async () => {
      await fecharSeAberto();
      const vendedor = await criarVendedor();

      const caixa = await service.abrir(vendedor.id, { valorInicial: 200, observacao: "Troco inicial" });

      expect(caixa.abertura.responsavelId).toBeNull();
      expect(caixa.abertura.responsavelNome).toBe("Loja");
      expect(caixa.abertura.valorInicial).toBe(200);

      // Confirma no banco: o documento persistido não tem NENHUM campo de vendedor.
      const documento = await connection.collection("caixas").findOne({ codigo: caixa.codigo });
      expect(documento?.["responsavelId"]).toBeUndefined();
      expect(documento?.["responsavelNome"]).toBeUndefined();
      expect(documento?.["abertura"]).toBeUndefined(); // domínio persistido é flat (sem subdocumento abertura)

      // O vendedor só aparece no EVENTO de auditoria.
      const evento = await connection.collection("eventos_caixa").findOne({ caixaId: new Types.ObjectId(caixa.id), tipo: "caixa.aberto" });
      expect(evento?.["usuarioId"]).toBe(vendedor.id);

      await fecharSeAberto();
    });

    it("registra o evento de auditoria caixa.aberto (mesmo tipo já usado pelo CaixasService)", async () => {
      await fecharSeAberto();
      const vendedor = await criarVendedor();
      const caixa = await service.abrir(vendedor.id, { valorInicial: 50 });

      const evento = await connection.collection("eventos_caixa").findOne({ caixaId: new Types.ObjectId(caixa.id), tipo: "caixa.aberto" });
      expect(evento).toBeTruthy();

      await fecharSeAberto();
    });

    it("tentar abrir com um caixa já aberto propaga o conflito do CaixasService (409)", async () => {
      await fecharSeAberto();
      const vendedorA = await criarVendedor();
      const vendedorB = await criarVendedor();

      await service.abrir(vendedorA.id, { valorInicial: 100 });
      await expect(service.abrir(vendedorB.id, { valorInicial: 100 })).rejects.toThrow(ApiException);

      await fecharSeAberto();
    });

    it("Etapa 18.2 — o Caixa não valida mais o vendedor (não tem vínculo): chamar o service diretamente com um id arbitrário não lança; a validação real do vendedor acontece antes, no PdvJwtAuthGuard", async () => {
      await fecharSeAberto();
      const caixa = await service.abrir("id-qualquer-nao-validado", { valorInicial: 100 });
      expect(caixa.abertura.responsavelId).toBeNull();
      expect(caixa.abertura.responsavelNome).toBe("Loja");
      await fecharSeAberto();
    });
  });
});
