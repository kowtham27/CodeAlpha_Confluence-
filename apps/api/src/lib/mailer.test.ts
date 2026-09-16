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

  it('tolerates the spacing people actually type', () => {
    expect(parseAddress('  Confluence   < hi@example.com >  ')).toEqual({
      name: 'Confluence',
      email: 'hi@example.com',
    });
  });
});
