import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/** Hashes and checks passwords and PINs with Argon2id. */
@Injectable()
export class PasswordService {
  // Verified against when the account does not exist, so the response time does not reveal that.
  private readonly decoy = argon2.hash('decoy-secret', { type: argon2.argon2id });

  hash(secret: string): Promise<string> {
    return argon2.hash(secret, { type: argon2.argon2id });
  }

  async verify(hash: string, secret: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, secret);
    } catch {
      return false;
    }
  }

  async verifyDecoy(secret: string): Promise<void> {
    await this.verify(await this.decoy, secret);
  }
}
