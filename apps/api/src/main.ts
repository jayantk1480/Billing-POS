import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';
import { setupApp } from './setup-app.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({ json: env.NODE_ENV === 'production', prefix: 'api' }),
  });
  setupApp(app);
  await app.listen(env.API_PORT);
  // The API documentation is switched off in production.
  new Logger('Bootstrap').log(`API listening on ${env.API_PUBLIC_URL}` + (env.NODE_ENV === 'production' ? '' : ' (docs at /api/docs)'));
}

await bootstrap();
