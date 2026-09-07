import { Module } from "@nestjs/common";
import { SaudeController } from "./saude.controller.js";
import { SaudeService } from "./saude.service.js";

@Module({
  controllers: [SaudeController],
  providers: [SaudeService],
})
export class SaudeModule {}
