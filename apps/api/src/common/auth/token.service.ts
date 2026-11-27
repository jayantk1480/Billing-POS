import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.js';

const ISSUER = 'pos-api';
const AUDIENCE = 'pos-apps';

export interface AccessClaims {
  userId: string;
  restaurantId: string;
  roleId: string;
  sessionId: string;
  terminalId: string | null;
}

/** Issues and checks access tokens, and creates opaque refresh tokens. */
@Injectable()
export class TokenService {
  private readonly secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

  signAccessToken(claims: AccessClaims): Promise<string> {
    return new SignJWT({ rid: claims.restaurantId, role: claims.roleId, sid: claims.sessionId, tid: claims.terminalId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${env.JWT_ACCESS_TTL_SECONDS}s`)
      .sign(this.secret);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
      const { sub, rid, role, sid, tid } = payload as Record<string, unknown>;
      if (typeof sub !== 'string' || typeof rid !== 'string' || typeof role !== 'string' || typeof sid !== 'string') {
        throw new Error('Malformed claims');
      }
      return { userId: sub, restaurantId: rid, roleId: role, sessionId: sid, terminalId: typeof tid === 'string' ? tid : null };
    } catch {
      throw new UnauthorizedException('Your session has expired. Sign in again.');
    }
  }

  /** A refresh or reset token: the raw value goes to the client, only the hash is stored. */
  newOpaqueToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
