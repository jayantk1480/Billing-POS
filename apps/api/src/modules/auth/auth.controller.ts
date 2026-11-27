import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type AuthResponse, type AuthUser, changePasswordSchema, type ClientApp, clientOnlySchema, forgotPasswordSchema,
  isNativeClient, loginSchema, pinLoginSchema, type PinUser, REFRESH_TOKEN_HEADER, resetPasswordSchema, selectTerminalSchema, type SessionInfo,
} from '@pos/validation';
import type { Request, Response } from 'express';
import { AllowWhenExpired, type AuthContext, CurrentAuth, Public } from '../../common/auth/auth-context.js';
import { TrustedOriginGuard } from '../../common/auth/origin.guard.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { env } from '../../config/env.js';
import { AuthService, type IssuedSession, type RequestMeta } from './auth.service.js';

class LoginDto extends createZodDto(loginSchema) {}
class ClientDto extends createZodDto(clientOnlySchema) {}
class PinLoginDto extends createZodDto(pinLoginSchema) {}
class SelectTerminalDto extends createZodDto(selectTerminalSchema) {}
class ForgotPasswordDto extends createZodDto(forgotPasswordSchema) {}
class ResetPasswordDto extends createZodDto(resetPasswordSchema) {}
class ChangePasswordDto extends createZodDto(changePasswordSchema) {}

const COOKIE_PATH = '/api/v1/auth';
const cookieName = (client: ClientApp) => `pos_rt_${client}`;
const meta = (req: Request): RequestMeta => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

@ApiTags('auth')
@AllowWhenExpired()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @RateLimit({ name: 'auth-login', limit: 10, windowSeconds: 60 })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiZodBody(LoginDto)
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    return this.respond(res, body.client, await this.auth.login(body, meta(req)));
  }

  @Public()
  @UseGuards(TrustedOriginGuard)
  @RateLimit({ name: 'auth-refresh', limit: 60, windowSeconds: 60 })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange the refresh cookie for a new access token' })
  @ApiZodBody(ClientDto)
  async refresh(@Body() body: ClientDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    return this.respond(res, body.client, await this.auth.refresh(this.cookie(req, body.client), body.client, meta(req)));
  }

  @Public()
  @UseGuards(TrustedOriginGuard)
  @RateLimit({ name: 'auth-pin', limit: 10, windowSeconds: 60 })
  @Post('pin-login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Switch user on a signed-in terminal with a PIN' })
  @ApiZodBody(PinLoginDto)
  async pinLogin(@Body() body: PinLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    return this.respond(res, body.client, await this.auth.pinLogin(this.cookie(req, body.client), body, meta(req)));
  }

  @Public()
  @UseGuards(TrustedOriginGuard)
  @Get('pin-users')
  @ApiOperation({ summary: 'Users who can sign in by PIN on this terminal' })
  pinUsers(@Query() query: ClientDto, @Req() req: Request): Promise<PinUser[]> {
    return this.auth.pinUsers(this.cookie(req, query.client), query.client);
  }

  @Public()
  @UseGuards(TrustedOriginGuard)
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out and revoke the session' })
  @ApiZodBody(ClientDto)
  async logout(@Body() body: ClientDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(this.cookie(req, body.client), meta(req));
    if (!isNativeClient(body.client)) res.clearCookie(cookieName(body.client), { path: COOKIE_PATH });
  }

  @Public()
  @RateLimit({ name: 'auth-forgot', limit: 5, windowSeconds: 900 })
  @Post('forgot-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Email a password reset link' })
  @ApiZodBody(ForgotPasswordDto)
  forgotPassword(@Body() body: ForgotPasswordDto): Promise<void> {
    return this.auth.forgotPassword(body.email);
  }

  @Public()
  @RateLimit({ name: 'auth-reset', limit: 10, windowSeconds: 900 })
  @Post('reset-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Set a new password using a reset link' })
  @ApiZodBody(ResetPasswordDto)
  resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(body.token, body.password);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'The signed-in user and their permissions' })
  me(@CurrentAuth() auth: AuthContext): Promise<AuthUser> {
    return this.auth.me(auth);
  }

  @ApiBearerAuth()
  @UseGuards(TrustedOriginGuard)
  @Post('terminal')
  @HttpCode(200)
  @ApiOperation({ summary: 'Choose which billing terminal this device is' })
  @ApiZodBody(SelectTerminalDto)
  async selectTerminal(
    @CurrentAuth() auth: AuthContext, @Body() body: SelectTerminalDto, @Req() req: Request, @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    const issued = await this.auth.selectTerminal(auth, this.cookie(req, body.client), body.client, body.terminalId, meta(req));
    return this.respond(res, body.client, issued);
  }

  @ApiBearerAuth()
  @Post('lock')
  @HttpCode(204)
  @ApiOperation({ summary: 'Lock this terminal until a PIN is entered' })
  lock(@CurrentAuth() auth: AuthContext): Promise<void> {
    return this.auth.lock(auth);
  }

  @ApiBearerAuth()
  @RateLimit({ name: 'auth-change-password', limit: 10, windowSeconds: 900 })
  @Post('change-password')
  @HttpCode(204)
  @ApiOperation({ summary: 'Change your own password' })
  @ApiZodBody(ChangePasswordDto)
  changePassword(@CurrentAuth() auth: AuthContext, @Body() body: ChangePasswordDto): Promise<void> {
    return this.auth.changePassword(auth, body);
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'Your active sessions' })
  sessions(@CurrentAuth() auth: AuthContext): Promise<SessionInfo[]> {
    return this.auth.listSessions(auth);
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out one of your sessions' })
  revokeSession(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.auth.revokeSession(auth, id);
  }

  /** The refresh token the caller holds: from its cookie, or for a native app from its header and never a cookie. */
  private cookie(req: Request, client: ClientApp): string | undefined {
    if (isNativeClient(client)) {
      const header = req.headers[REFRESH_TOKEN_HEADER];
      return typeof header === 'string' && header ? header : undefined;
    }
    return (req.cookies as Record<string, string | undefined> | undefined)?.[cookieName(client)];
  }

  /**
   * Puts the refresh token in an HttpOnly cookie scoped to the auth routes; returns the rest as JSON.
   * A native app has no cookie jar to trust, so it gets the token in the answer and keeps it in the device's secure storage.
   */
  private respond(res: Response, client: ClientApp, issued: IssuedSession): AuthResponse {
    if (isNativeClient(client)) return { ...issued.response, refreshToken: issued.refreshToken };
    res.cookie(cookieName(client), issued.refreshToken, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: issued.refreshExpiresAt,
    });
    return issued.response;
  }
}
