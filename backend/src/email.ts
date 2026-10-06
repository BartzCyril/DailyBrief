import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "./config";
export type NewsletterMessage = { to: string; newsletterId: string; subject: string; html: string; text: string };
export interface NewsletterSender { send(message: NewsletterMessage): Promise<void> }
export class NewsletterEmailService implements NewsletterSender {
  private transport: Transporter;
  constructor(private config: Config, transport?: Transporter) {
    this.transport = transport ?? nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000, ...(config.SMTP_USER && config.SMTP_PASSWORD ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}) });
  }
  async send(message: NewsletterMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.SMTP_FROM, to: message.to, subject: message.subject, html: message.html, text: message.text, messageId: `<${message.newsletterId}@dailybrief.local>`, disableFileAccess: true, disableUrlAccess: true });
  }
}
