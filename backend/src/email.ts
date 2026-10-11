import type { Transporter } from "nodemailer";
import type { Config } from "./config";
import { AppError } from "./errors";
import { createSmtpTransport } from "./smtp";
export type NewsletterMessage = {
  to: string;
  newsletterId: string;
  subject: string;
  html: string;
  text: string;
};
export interface NewsletterSender {
  send(message: NewsletterMessage): Promise<void>;
}
export class NewsletterEmailService implements NewsletterSender {
  private transport: Transporter;
  constructor(
    private config: Config,
    transport?: Transporter,
  ) {
    this.transport = transport ?? createSmtpTransport(config);
  }
  async send(message: NewsletterMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.config.SMTP_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        messageId: `<${message.newsletterId}@dailybrief.local>`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "command" in error &&
        error.command === "DATA" &&
        !("responseCode" in error && typeof error.responseCode === "number")
      )
        throw new AppError(
          502,
          "Livraison SMTP incertaine. Vérifiez le serveur avant de retenter.",
          "SMTP_UNCERTAIN",
        );
      throw new AppError(503, "L'envoi SMTP a échoué.", "SMTP_FAILED");
    }
  }
}
