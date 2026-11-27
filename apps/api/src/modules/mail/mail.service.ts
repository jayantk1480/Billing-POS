import { Global, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Sends email over SMTP. Locally this is Mailpit, which captures messages instead of delivering them. */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger('MailService');
  private readonly transport: Transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: env.SMTP_FROM, ...mail });
    this.logger.log(`Sent "${mail.subject}"`);
  }

  onModuleDestroy(): void {
    this.transport.close();
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
