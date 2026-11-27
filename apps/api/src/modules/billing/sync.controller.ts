import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { checkSyncReviewSchema, type Page, type SyncPushResponse, syncPushSchema, type SyncReviewDto, syncReviewQuerySchema } from '@pos/validation';
import { AllowWhenExpired, type AuthContext, CurrentAuth, RequirePermissions } from '../../common/auth/auth-context.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { SyncService } from './sync.service.js';

class SyncPushDto extends createZodDto(syncPushSchema) {}
class SyncReviewQueryDto extends createZodDto(syncReviewQuerySchema) {}
class CheckSyncReviewDto extends createZodDto(checkSyncReviewSchema) {}

@ApiTags('sync')
@ApiBearerAuth()
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('push')
  @RequirePermissions('order.create')
  // Bills printed while offline must reach the server even after the trial or paid period has run out.
  @AllowWhenExpired()
  @HttpCode(200)
  @ApiOperation({ summary: 'Upload what this device did offline: orders, kitchen tickets, bills and payments, each applied once' })
  @ApiZodBody(SyncPushDto)
  push(@CurrentAuth() auth: AuthContext, @Body() body: SyncPushDto): Promise<SyncPushResponse> {
    return this.sync.push(auth, body);
  }

  @Get('reviews')
  @RequirePermissions('payment.reconcile')
  @ApiOperation({ summary: 'Uploads from devices that need a look: stored with flags, or refused' })
  reviews(@CurrentAuth() auth: AuthContext, @Query() query: SyncReviewQueryDto): Promise<Page<SyncReviewDto>> {
    return this.sync.reviews(auth, query);
  }

  @Post('reviews/:id/check')
  @RequirePermissions('payment.reconcile')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark an upload as checked' })
  @ApiZodBody(CheckSyncReviewDto)
  check(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CheckSyncReviewDto): Promise<SyncReviewDto> {
    return this.sync.check(auth, id, body);
  }
}
