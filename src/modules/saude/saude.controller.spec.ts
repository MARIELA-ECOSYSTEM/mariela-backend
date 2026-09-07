import { describe, expect, it } from "bun:test";
import { Test } from "@nestjs/testing";
import { SaudeController } from "./saude.controller.js";
import { SaudeService, type StatusSaude } from "./saude.service.js";

describe("SaudeController", () => {
  it("devolve o status informado pelo SaudeService", async () => {
    const statusFalso: StatusSaude = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: 12.3,
      database: { status: "up", readyState: 1 },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [SaudeController],
      providers: [{ provide: SaudeService, useValue: { verificar: () => statusFalso } }],
    }).compile();

    const controller = moduleRef.get(SaudeController);
    expect(controller.verificar()).toEqual(statusFalso);
  });
});
