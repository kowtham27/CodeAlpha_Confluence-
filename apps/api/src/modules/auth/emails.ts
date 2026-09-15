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
  return `<p style="margin:24px 0"><a href="${href}" style="display:inline-block;background:#0b57d0;color:#fff;text-decoration:none;padding:10px 24px;border-radius:999px;font-weight:500">${label}</a></p>`;
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

/** Same fragment-and-POST pattern as verification; see verificationEmail. */
export function passwordResetEmail(to: string, displayName: string, token: string): MailMessage {
  const link = `${env.WEB_ORIGIN}/reset-password#token=${token}`;
  const name = escapeHtml(displayName);
  return {
    to,
    subject: 'Reset your Confluence password',
    text: [
      `Hi ${displayName},`,
      '',
      'Someone asked to reset the password for your Confluence account.',
      'Choose a new password here:',
      link,
      '',
      'The link expires in 1 hour and works once. If you did not ask for this,',
      'ignore this email: your password stays the same.',
    ].join('\n'),
    html: layout(
      'Reset your password',
      `<p style="margin:0 0 8px">Hi ${name},</p>
       <p style="margin:0">Someone asked to reset the password for your account. Choose a new one below.</p>
       ${button(link, 'Choose a new password')}
       <p style="margin:0;font-size:13px;color:#646b7a">The link expires in 1 hour and works once. If you did not ask for this, ignore this email: your password stays the same.</p>`,
    ),
  };
}

/**
 * Sent after every successful reset. If the owner did not do it, this is how
 * they find out, so it names the consequence (every device signed out) and
 * what to do next.
 */
export function passwordChangedEmail(to: string, displayName: string): MailMessage {
  const link = `${env.WEB_ORIGIN}/forgot-password`;
  const name = escapeHtml(displayName);
  return {
    to,
    subject: 'Your Confluence password was changed',
    text: [
      `Hi ${displayName},`,
      '',
      'The password for your Confluence account was just changed, and every',
      'device that was signed in has been signed out.',
      '',
      'If this was not you, reset your password right away:',
      link,
    ].join('\n'),
    html: layout(
      'Your password was changed',
      `<p style="margin:0 0 8px">Hi ${name},</p>
       <p style="margin:0">The password for your account was just changed, and every device that was signed in has been signed out.</p>
       <p style="margin:16px 0 0">If this was not you, reset your password right away.</p>
       ${button(link, 'Reset password')}`,
    ),
  };
}
