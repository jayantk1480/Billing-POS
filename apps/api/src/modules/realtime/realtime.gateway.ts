import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { type OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { RealtimeEvent } from '@pos/types';
import type { Server, Socket } from 'socket.io';
import { PermissionCacheService } from '../../common/auth/permission-cache.service.js';
import { TokenService } from '../../common/auth/token.service.js';
import { env } from '../../config/env.js';

const room = (restaurantId: string) => 'restaurant:' + restaurantId;

/**
 * Pushes "something changed" notices to signed-in screens. A notice carries only ids; the screen
 * then asks the REST API for the data, so permissions are enforced there as usual.
 */
@WebSocketGateway({ cors: { origin: env.CORS_ORIGINS, credentials: true } })
export class RealtimeGateway implements OnGatewayInit {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('Realtime');

  constructor(
    private readonly tokens: TokenService,
    private readonly permissionCache: PermissionCacheService,
  ) {}

  afterInit(server: Server): void {
    // A socket must present a valid access token before it joins anything.
    server.use((socket: Socket, next) => {
      this.admit(socket).then(() => next(), () => next(new Error('UNAUTHORIZED')));
    });
  }

  private async admit(socket: Socket): Promise<void> {
    const token = (socket.handshake.auth as { token?: unknown }).token;
    if (typeof token !== 'string') throw new Error('No token');
    const claims = await this.tokens.verifyAccessToken(token);
    const { revoked } = await this.permissionCache.load(claims.sessionId, claims.roleId);
    if (revoked) throw new Error('Session ended');
    await socket.join(room(claims.restaurantId));
  }

  emit(restaurantId: string, event: RealtimeEvent, payload: Record<string, unknown>): void {
    try {
      this.server.to(room(restaurantId)).emit(event, payload);
    } catch (error) {
      // A missed notice only delays a screen until its next poll; it must never fail the request.
      this.logger.warn('Could not send ' + event + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
}

/** What services call to tell screens about a change. */
@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  emit(restaurantId: string, event: RealtimeEvent, payload: Record<string, unknown> = {}): void {
    this.gateway.emit(restaurantId, event, payload);
  }
}

@Global()
@Module({ providers: [RealtimeGateway, RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
