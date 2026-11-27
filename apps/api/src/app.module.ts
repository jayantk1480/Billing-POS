import { Module } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AuthGuard } from './common/auth/auth.guard.js';
import { RateLimitGuard } from './common/rate-limit/rate-limit.js';
import { SecurityModule } from './common/security.module.js';
import { ZodValidationPipe } from './common/zod.js';
import { AuditModule } from './modules/audit/audit.service.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BillingModule } from './modules/billing/billing.controller.js';
import { CustomersModule } from './modules/customers/customers.controller.js';
import { FilesModule } from './modules/files/files.controller.js';
import { HealthModule } from './modules/health/health.module.js';
import { MailModule } from './modules/mail/mail.service.js';
import { MenuModule } from './modules/menu/menu.controller.js';
import { PlatformModule } from './modules/platform/platform.controller.js';
import { PrintingModule } from './modules/printing/printing.controller.js';
import { PrismaModule } from './modules/prisma/prisma.module.js';
import { RealtimeModule } from './modules/realtime/realtime.gateway.js';
import { RedisModule } from './modules/redis/redis.module.js';
import { RegistersModule } from './modules/registers/registers.controller.js';
import { ReportsModule } from './modules/reports/reports.controller.js';
import { RestaurantModule } from './modules/restaurant/restaurant.controller.js';
import { SignupModule } from './modules/signup/signup.controller.js';
import { UsersModule } from './modules/users/users.module.js';

@Module({
  imports: [
    PrismaModule, RedisModule, SecurityModule, RealtimeModule, AuditModule, MailModule, FilesModule,
    HealthModule, AuthModule, UsersModule, RestaurantModule, MenuModule, PrintingModule, BillingModule, CustomersModule, RegistersModule, ReportsModule, SignupModule, PlatformModule,
  ],
  providers: [
    // Order matters: throttle first, then authenticate and authorise.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
