import { Module } from '@nestjs/common';
import { CleanupService } from './cleanup.service.js';
import { HealthController } from './health.controller.js';

@Module({ controllers: [HealthController], providers: [CleanupService] })
export class HealthModule {}
