import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';

export const REDIS = Symbol('REDIS');

@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

/** One shared Redis connection, injected with `@Inject(REDIS)`. */
@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false }) },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
