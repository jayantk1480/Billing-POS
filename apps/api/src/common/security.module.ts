import { Global, Module } from '@nestjs/common';
import { PasswordService } from './auth/password.service.js';
import { PermissionCacheService } from './auth/permission-cache.service.js';
import { TokenService } from './auth/token.service.js';
import { RateLimiter } from './rate-limit/rate-limit.js';

/** Security building blocks used by the global guards and by feature modules. */
@Global()
@Module({
  providers: [TokenService, PasswordService, PermissionCacheService, RateLimiter],
  exports: [TokenService, PasswordService, PermissionCacheService, RateLimiter],
})
export class SecurityModule {}
