import { describe, expect, it } from 'vitest';
import { parseAddress } from './mailer.js';

describe('parseAddress', () => {
  it('splits "Name <address>", which is how MAIL_FROM is written', () => {
    expect(parseAddress('Confluence <hi@example.com>')).toEqual({
      name: 'Confluence',
      email: 'hi@example.com',
    });
  });

  it('accepts a bare address, and a quoted name', () => {
    expect(parseAddress('hi@example.com')).toEqual({ name: '', email: 'hi@example.com' });
    expect(parseAddress('"Confluence Meetings" <hi@example.com>')).toEqual({
      name: 'Confluence Meetings',
      email: 'hi@example.com',
    });
  });

  /**
   * .env files quote the value to keep the spaces and dotenv strips them,
   * but a hosting dashboard stores the quotes as part of the value. Both
   * Brevo failures seen in production came from this.
   */
  it('strips quotes wrapped around the whole value, as a dashboard stores them', () => {
    expect(parseAddress('"Confluence <hi@example.com>"')).toEqual({
      name: 'Confluence',
      email: 'hi@example.com',
    });
    expect(parseAddress("'Confluence <hi@example.com>'")).toEqual({
      name: 'Confluence',
      email: 'hi@example.com',
    });
    expect(parseAddress('"hi@example.com"')).toEqual({ name: '', email: 'hi@example.com' });
  });

  it('never returns an address with punctuation a provider would reject', () => {
    for (const value of [
      'Confluence <hi@example.com>',
      '"Confluence <hi@example.com>"',
      '  hi@example.com  ',
      '"Confluence Meetings" <hi@example.com>',
    ]) {
      expect(parseAddress(value).email).toBe('hi@example.com');
    }
  });

  it('tolerates the spacing people actually type', () => {
    expect(parseAddress('  Confluence   < hi@example.com >  ')).toEqual({
      name: 'Confluence',
      email: 'hi@example.com',
    });
  });
});
