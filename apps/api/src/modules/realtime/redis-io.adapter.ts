import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { env } from '../../config/env.js';

/**
 * Socket.IO over Redis pub/sub, so a notice raised on one API instance reaches screens connected
 * to any other instance.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly publisher = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  private readonly subscriber = this.publisher.duplicate();

  constructor(app: INestApplicationContext) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    server.adapter(createAdapter(this.publisher, this.subscriber));
    return server;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()]);
  }
}
