import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaClient } from '@pos/database';
import type { HealthResponse } from '@pos/validation';
import { Redis } from 'ioredis';
import { Public } from '../../common/auth/auth-context.js';
import { REDIS } from '../redis/redis.module.js';

const VERSION = process.env.npm_package_version ?? '0.1.0';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Reports whether the API, database and Redis are reachable' })
  @ApiOkResponse({ description: 'Service status' })
  async check(): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => 'up' as const, () => 'down' as const),
      this.redis.ping().then(() => 'up' as const, () => 'down' as const),
    ]);
    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
      version: VERSION,
      database,
      redis,
      time: new Date().toISOString(),
    };
  }
}
