import { describe, expect, it } from "bun:test";
import { Test } from "@nestjs/testing";
import type { Response } from "express";
import { SaudeController } from "./saude.controller.js";
import { SaudeService, type StatusSaude } from "./saude.service.js";

/** Fake mínimo de `Response` do Express — só o suficiente para capturar o status definido pelo controller (`res.status(...)`), sem subir um servidor HTTP real. */
function respostaFalsa(): { res: Response; statusRecebido: () => number | undefined } {
  let statusRecebido: number | undefined;
  const res = { status: (codigo: number) => ((statusRecebido = codigo), res) } as unknown as Response;
  return { res, statusRecebido: () => statusRecebido };
}

async function criarController(statusFalso: StatusSaude): Promise<SaudeController> {
  const moduleRef = await Test.createTestingModule({
    controllers: [SaudeController],
    providers: [{ provide: SaudeService, useValue: { verificar: () => statusFalso } }],
  }).compile();
  return moduleRef.get(SaudeController);
}

describe("SaudeController", () => {
  it("devolve o status informado pelo SaudeService", async () => {
    const statusFalso: StatusSaude = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: 12.3,
      database: { status: "up", readyState: 1 },
    };
    const controller = await criarController(statusFalso);
    const { res } = respostaFalsa();
    expect(controller.verificar(res)).toEqual(statusFalso);
  });

  it("Etapa 18.23 — status 'ok' responde HTTP 200", async () => {
    const statusFalso: StatusSaude = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: 1,
      database: { status: "up", readyState: 1 },
    };
    const controller = await criarController(statusFalso);
    const { res, statusRecebido } = respostaFalsa();
    controller.verificar(res);
    expect(statusRecebido()).toBe(200);
  });

  it("Etapa 18.23 — status 'degradado' (MongoDB indisponível) responde HTTP 503, preservando o corpo rico", async () => {
    const statusFalso: StatusSaude = {
      status: "degradado",
      timestamp: new Date().toISOString(),
      uptime: 1,
      database: { status: "down", readyState: 0 },
    };
    const controller = await criarController(statusFalso);
    const { res, statusRecebido } = respostaFalsa();
    const corpo = controller.verificar(res);
    expect(statusRecebido()).toBe(503);
    expect(corpo).toEqual(statusFalso);
  });
});
