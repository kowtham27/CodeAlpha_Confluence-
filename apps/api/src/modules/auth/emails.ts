import { env } from '../../config/env.js';
import type { MailMessage } from '../../lib/mailer.js';

/** Display names are user input and must never reach HTML unescaped. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:32px 16px;background:#f6f7f9;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1f2330">
  <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e3e5ea;border-radius:12px;padding:32px">
    <p style="margin:0 0 24px;font-weight:600;font-size:15px">Confluence</p>
    <h1 style="margin:0 0 16px;font-size:20px">${heading}</h1>
    ${bodyHtml}
  </div>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${href}" style="display:inline-block;background:#3b6fd9;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:500">${label}</a></p>`;
}

/**
 * The token travels in the URL fragment (#token=...), which browsers never
 * send to a server, so it cannot leak into access logs or Referer headers.
 * The page then submits it with a POST, so a mail scanner that pre-fetches
 * links cannot consume it by accident.
 */
export function verificationEmail(to: string, displayName: string, token: string): MailMessage {
  const link = `${env.WEB_ORIGIN}/verify-email#token=${token}`;
  const name = escapeHtml(displayName);
  return {
    to,
    subject: 'Verify your email for Confluence',
    text: [
      `Hi ${displayName},`,
      '',
      'Confirm this is your email address to finish creating your Confluence account:',
      link,
      '',
      'The link expires in 24 hours. If you did not sign up, ignore this email.',
    ].join('\n'),
    html: layout(
      'Confirm your email',
      `<p style="margin:0 0 8px">Hi ${name},</p>
       <p style="margin:0">Confirm this is your email address to finish creating your account.</p>
       ${button(link, 'Verify email')}
       <p style="margin:0;font-size:13px;color:#646b7a">The link expires in 24 hours. If you did not sign up, you can ignore this email.</p>`,
    ),
  };
}

/**
 * Sent instead of an error when someone registers with an email that already
 * has a verified account. The registration response is identical either way,
 * so only the owner of the inbox learns the account exists.
 */
export function alreadyRegisteredEmail(to: string, displayName: string): MailMessage {
  const link = `${env.WEB_ORIGIN}/login`;
  const name = escapeHtml(displayName);
  return {
    to,
    subject: 'Someone tried to sign up with your email',
    text: [
      `Hi ${displayName},`,
      '',
      'Someone just tried to create a Confluence account with this email address,',
      'but you already have one. If that was you, sign in instead:',
      link,
      '',
      'If it was not you, no action is needed. Your account is unchanged.',
    ].join('\n'),
    html: layout(
      'You already have an account',
      `<p style="margin:0 0 8px">Hi ${name},</p>
       <p style="margin:0">Someone just tried to create an account with this email address, but you already have one. If that was you, sign in instead.</p>
       ${button(link, 'Sign in')}
       <p style="margin:0;font-size:13px;color:#646b7a">If it was not you, no action is needed. Your account is unchanged.</p>`,
    ),
  };
}
