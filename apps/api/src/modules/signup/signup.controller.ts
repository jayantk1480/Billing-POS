import { Body, Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type OnboardingDto, resendVerificationSchema, signupSchema, verifyEmailSchema } from '@pos/validation';
import { type AuthContext, CurrentAuth, Public, RequirePermissions } from '../../common/auth/auth-context.js';
import { RateLimit } from '../../common/rate-limit/rate-limit.js';
import { ApiZodBody, createZodDto } from '../../common/zod.js';
import { env } from '../../config/env.js';
import { SignupService } from './signup.service.js';

class SignupDto extends createZodDto(signupSchema) {}
class VerifyEmailDto extends createZodDto(verifyEmailSchema) {}
class ResendVerificationDto extends createZodDto(resendVerificationSchema) {}

@ApiTags('sign-up')
@Controller()
export class SignupController {
  constructor(private readonly signups: SignupService) {}

  @Public()
  @Get('signup/options')
  @ApiOperation({ summary: 'Whether restaurants can register themselves, and how long the free trial is' })
  options(): { enabled: boolean; trialDays: number } {
    return { enabled: env.SIGNUP_ENABLED, trialDays: env.TRIAL_DAYS };
  }

  @Public()
  // Each registration creates a restaurant and sends an email, so one address may not do it often.
  @RateLimit({ name: 'signup', limit: 5, windowSeconds: 3600 })
  @Post('signup')
  @HttpCode(202)
  @ApiOperation({ summary: 'Register a new restaurant. The owner confirms their email before signing in.' })
  @ApiZodBody(SignupDto)
  async signup(@Body() body: SignupDto): Promise<void> {
    await this.signups.signup(body);
  }

  @Public()
  @RateLimit({ name: 'signup-verify', limit: 20, windowSeconds: 600 })
  @Post('signup/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm the email address with the link that was sent to it' })
  @ApiZodBody(VerifyEmailDto)
  verify(@Body() body: VerifyEmailDto): Promise<{ email: string }> {
    return this.signups.verify(body.token);
  }

  @Public()
  @RateLimit({ name: 'signup-resend', limit: 5, windowSeconds: 3600 })
  @Post('signup/resend')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send the confirmation link again' })
  @ApiZodBody(ResendVerificationDto)
  async resend(@Body() body: ResendVerificationDto): Promise<void> {
    await this.signups.resend(body.email);
  }

  @Get('onboarding')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'What is still to do before the restaurant can trade' })
  onboarding(@CurrentAuth() auth: AuthContext): Promise<OnboardingDto> {
    return this.signups.onboarding(auth);
  }

  @Post('onboarding/dismiss')
  @HttpCode(200)
  @ApiBearerAuth()
  @RequirePermissions('settings.manage')
  @ApiOperation({ summary: 'Hide the getting-started list for good' })
  dismiss(@CurrentAuth() auth: AuthContext): Promise<OnboardingDto> {
    return this.signups.dismissOnboarding(auth);
  }
}

@Module({ controllers: [SignupController], providers: [SignupService] })
export class SignupModule {}
