import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, PrismaClient } from '@pos/database';
import { env } from '../../config/env.js';

/** Closes the connection pool when the application shuts down. */
@Injectable()
class PrismaLifecycle implements OnModuleDestroy {
  constructor(private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Makes one shared PrismaClient injectable everywhere as `PrismaClient`. */
@Global()
@Module({
  providers: [{ provide: PrismaClient, useFactory: () => createPrismaClient(env.DATABASE_URL) }, PrismaLifecycle],
  exports: [PrismaClient],
})
export class PrismaModule {}
