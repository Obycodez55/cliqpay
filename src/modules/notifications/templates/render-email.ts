import { readFileSync } from 'fs';
import { join } from 'path';
import Handlebars from 'handlebars';

const EMAIL_TEMPLATES_DIR = join(__dirname, 'email');

function compile(fileName: string): HandlebarsTemplateDelegate {
  return Handlebars.compile(
    readFileSync(join(EMAIL_TEMPLATES_DIR, fileName), 'utf-8'),
  );
}

// Compiled once at module load, not per send — these files are the module's
// entire template set, all needed on every boot regardless of which one a
// given send uses.
const layout = compile('layout.hbs');
const bodies = {
  email_verification_otp: compile('email-verification-otp.hbs'),
  password_reset_otp: compile('password-reset-otp.hbs'),
  mfa_challenge_otp: compile('mfa-challenge-otp.hbs'),
  security_alert: compile('security-alert.hbs'),
  funding_completed: compile('funding-completed.hbs'),
  reconciliation_mismatch: compile('reconciliation-mismatch.hbs'),
};

// The plain-text part is a low-fidelity fallback almost no mail client
// actually shows — not worth hand-authoring a second template per type, so
// it's derived from the rendered HTML instead.
const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&copy;': '©',
};

function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

export function renderEmail<T extends keyof typeof bodies>(
  templateName: T,
  payload: object,
): { html: string; text: string } {
  const body = bodies[templateName](payload);
  const html = layout({ body, year: new Date().getFullYear() });
  return { html, text: htmlToText(html) };
}
