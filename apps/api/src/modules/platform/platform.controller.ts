import { Body, Controller, Get, HttpCode, Module, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type Page, type PlatformAdminDto, platformCreateRestaurantSchema, platformLoginSchema, type PlatformOverviewDto, type PlatformRestaurantDetailDto,
  type PlatformRestaurantDto, platformRestaurantQuerySchema, setPaidUntilSchema, setTrialSchema, suspendRestaurantSchema,
} from '@pos/validation';
import type { Request, Response } from 'express';
import { Public } from '../../common/auth/auth-context.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { env } from '../../config/env.js';
import {
  CurrentAdmin, PLATFORM_COOKIE, PLATFORM_COOKIE_PATH, type PlatformActor, PlatformAuthService, PlatformGuard, PlatformOriginGuard,
} from './platform-auth.js';
import { PlatformService } from './platform.service.js';

class LoginDto extends createZodDto(platformLoginSchema) {}
class RestaurantQueryDto extends createZodDto(platformRestaurantQuerySchema) {}
class CreateRestaurantDto extends createZodDto(platformCreateRestaurantSchema) {}
class SuspendDto extends createZodDto(suspendRestaurantSchema) {}
class SetTrialDto extends createZodDto(setTrialSchema) {}
class SetPaidUntilDto extends createZodDto(setPaidUntilSchema) {}

const cookieOptions = { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict' as const, path: PLATFORM_COOKIE_PATH };
const cookieOf = (req: Request) => (req.cookies as Record<string, string> | undefined)?.[PLATFORM_COOKIE];

// "Public" only in the sense that a restaurant sign-in is not what opens these routes: each one is behind
// PlatformOriginGuard or PlatformGuard instead.
@ApiTags('platform')
@Public()
@Controller('platform')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('login')
  @UseGuards(PlatformOriginGuard)
  @RateLimit({ name: 'platform-login', limit: 5, windowSeconds: 60 })
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in to the platform admin app' })
  @ApiZodBody(LoginDto)
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<PlatformAdminDto> {
    const { admin, token, expiresAt } = await this.auth.login(body, { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
    res.cookie(PLATFORM_COOKIE, token, { ...cookieOptions, expires: expiresAt });
    return admin;
  }

  @Post('logout')
  @UseGuards(PlatformOriginGuard)
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out of the platform admin app' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(cookieOf(req));
    res.clearCookie(PLATFORM_COOKIE, cookieOptions);
  }

  @Get('me')
  @UseGuards(PlatformGuard)
  @ApiOperation({ summary: 'The signed-in platform admin' })
  me(@CurrentAdmin() admin: PlatformActor): PlatformAdminDto {
    return { id: admin.id, name: admin.name, email: admin.email };
  }
}

@ApiTags('platform')
@Public()
@UseGuards(PlatformGuard)
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('overview')
  @ApiOperation({ summary: 'How many restaurants there are, by state, and which trials end soon' })
  overview(): Promise<PlatformOverviewDto> {
    return this.platform.overview();
  }

  @Get('restaurants')
  @ApiOperation({ summary: 'Every restaurant, with its owner, subscription and how much it is used' })
  list(@Query() query: RestaurantQueryDto): Promise<Page<PlatformRestaurantDto>> {
    return this.platform.list(query);
  }

  @Post('restaurants')
  @ApiOperation({ summary: 'Set up a restaurant for someone; they are emailed a link to choose a password' })
  @ApiZodBody(CreateRestaurantDto)
  create(@CurrentAdmin() admin: PlatformActor, @Body() body: CreateRestaurantDto): Promise<PlatformRestaurantDetailDto> {
    return this.platform.create(admin, body);
  }

  @Get('restaurants/:id')
  @ApiOperation({ summary: 'One restaurant, for support. Recorded in the restaurant\'s audit log.' })
  detail(@CurrentAdmin() admin: PlatformActor, @Param('id', ParseUUIDPipe) id: string): Promise<PlatformRestaurantDetailDto> {
    return this.platform.detail(admin, id);
  }

  @Post('restaurants/:id/invite')
  @RateLimit({ name: 'platform-invite', limit: 20, windowSeconds: 3600 })
  @HttpCode(204)
  @ApiOperation({ summary: 'Email the owner a link to choose a password' })
  invite(@CurrentAdmin() admin: PlatformActor, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.platform.invite(admin, id);
  }

  @Post('restaurants/:id/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop everyone at the restaurant from signing in' })
  @ApiZodBody(SuspendDto)
  suspend(@CurrentAdmin() admin: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: SuspendDto): Promise<PlatformRestaurantDetailDto> {
    return this.platform.suspend(admin, id, body.reason);
  }

  @Post('restaurants/:id/reactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Lift a suspension' })
  reactivate(@CurrentAdmin() admin: PlatformActor, @Param('id', ParseUUIDPipe) id: string): Promise<PlatformRestaurantDetailDto> {
    return this.platform.reactivate(admin, id);
  }

  @Put('restaurants/:id/trial')
  @ApiOperation({ summary: 'Set the day the free trial ends' })
  @ApiZodBody(SetTrialDto)
  setTrial(@CurrentAdmin() admin: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetTrialDto): Promise<PlatformRestaurantDetailDto> {
    return this.platform.setTrial(admin, id, body);
  }

  @Put('restaurants/:id/paid-until')
  @ApiOperation({ summary: 'Record the last day the restaurant has paid for' })
  @ApiZodBody(SetPaidUntilDto)
  setPaidUntil(@CurrentAdmin() admin: PlatformActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: SetPaidUntilDto): Promise<PlatformRestaurantDetailDto> {
    return this.platform.setPaidUntil(admin, id, body);
  }
}

@Module({
  controllers: [PlatformAuthController, PlatformController],
  providers: [PlatformAuthService, PlatformService, PlatformGuard, PlatformOriginGuard],
})
export class PlatformModule {}
