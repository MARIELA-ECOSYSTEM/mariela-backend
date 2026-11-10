/**
 * Fase 21.2.11-CI.5 — preload SÓ DE TESTES, aplicado pelo CI (`bun test --preload`).
 * Contorno de uma falha intermitente do Bun 1.4.2: `require()` de módulo ESM ainda em
 * avaliação ("require() async module … @nestjs/common|core/index.js is unsupported"),
 * observada no CI #80 e nos diagnósticos da branch diag/ci-bun-nest-esm. Carregar
 * @nestjs/common e @nestjs/core ANTES dos arquivos de teste evita que um `require()`
 * de CJS (ex.: @nestjs/throttler) os encontre no meio da avaliação.
 * Fora do build (`tsconfig.build.json` exclui src/test-utils) e da imagem de produção.
 * Remover quando o Bun/NestJS corrigirem a interoperabilidade (reavaliar a cada atualização).
 */
import "@nestjs/common";
import "@nestjs/core";
