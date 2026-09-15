/**
 * Sends one email with the same settings the API uses, and says plainly what
 * went wrong if it fails:
 *
 *   pnpm mail:test you@example.com
 *
 * In the containers: docker compose --env-file .env -f infra/docker-compose.yml
 *   exec api node apps/api/dist/scripts/send-test-email.js you@example.com
 */
/* eslint-disable no-console -- a command-line tool: the console is its output */

// This script reports for itself: keep the API's JSON log lines out of it.
// Set before the imports below, which read it once.
process.env['LOG_LEVEL'] = 'silent';
const { env } = await import('../config/env.js');
const { mailDestination, mailer } = await import('../lib/mailer.js');

const to = process.argv[2];
if (!to?.includes('@')) {
  console.error('Usage: pnpm mail:test you@example.com');
  process.exit(1);
}

console.log(`Sending a test email to ${to}\n  via  ${mailDestination}\n  from ${env.MAIL_FROM}`);
try {
  await mailer.send({
    to,
    subject: 'Confluence test email',
    text: 'If you can read this, Confluence can send email. Verification and password reset emails will arrive the same way.',
    html: '<p>If you can read this, Confluence can send email.</p><p>Verification and password reset emails will arrive the same way.</p>',
  });
  console.log(
    env.SMTP_HOST
      ? 'Sent. Check the inbox, and the spam folder the first time.'
      : 'Sent to Mailpit (real email is off): open http://localhost:8025',
  );
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nNot sent: ${message}`);
  if (/535|Username and Password not accepted|Invalid login/i.test(message)) {
    console.error(
      'The server rejected the login. For Gmail, SMTP_PASS must be an App Password\n' +
        '(https://myaccount.google.com/apppasswords, needs 2-Step Verification),\n' +
        'not your normal Google password, and SMTP_USER must be that Gmail address.',
    );
  } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(message)) {
    console.error(
      env.SMTP_HOST
        ? 'Could not reach the SMTP server: check SMTP_HOST and SMTP_PORT, and that\nyour network allows outgoing SMTP.'
        : 'Could not reach Mailpit: start it with pnpm infra:up.',
    );
  }
  process.exit(1);
}
