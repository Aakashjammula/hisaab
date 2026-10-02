import type { Mailer } from '../../ports/index.ts';

type Message = Parameters<Mailer['send']>[0];

/** Sends through Cloudflare Email Routing's send_email binding (free to verified destination addresses). */
export class CloudflareMailer implements Mailer {
  constructor(private binding: SendEmail, private from: string, private fromName: string) {}

  async send(m: Message) {
    await this.binding.send({ from: { email: this.from, name: this.fromName }, to: m.to, subject: m.subject, text: m.text, html: m.html });
  }
}

/** Local development: print the code instead of emailing it. */
export class ConsoleMailer implements Mailer {
  async send(m: Message) {
    console.log(`\n✉️  To ${m.to}: ${m.subject}\n`);
  }
}

/** Tests: keep messages in memory so a test can read the code. */
export const testOutbox: Message[] = [];
export class MemoryMailer implements Mailer {
  async send(m: Message) { testOutbox.push(m); }
}
