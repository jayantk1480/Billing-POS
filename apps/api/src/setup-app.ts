import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ApiExceptionFilter } from './common/filters/api-exception.filter.js';
import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { env } from './config/env.js';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter.js';

/** Applies the middleware, routing and documentation shared by the server and the tests. */
export function setupApp(app: NestExpressApplication): void {
  // Needed for the real client IP (rate limits, audit log) when running behind a load balancer.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: [...new Set([...env.CORS_ORIGINS, env.ADMIN_URL])], credentials: true, exposedHeaders: ['x-request-id', 'content-disposition'] });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useWebSocketAdapter(new RedisIoAdapter(app));
  app.enableShutdownHooks();

  if (env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle(`${env.APP_NAME} API`)
      .setDescription('Restaurant POS and billing API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }
}
