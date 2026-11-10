import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarReference, sourceUrl } from '../src/domain/primitives.js';

interface RefsModule {
  calendarRef(value: unknown): string | null;
  sourceUrlLine(value: unknown): string;
}

const { calendarRef, sourceUrlLine } = (await import(new URL('../../public/refs.js', import.meta.url).href)) as RefsModule;

const ID = '0123456789abcdef01234567';
const LINK = `https://unical.prod.up.cineca.it/calendarioPubblico/linkCalendarioId=${ID}`;

const INPUTS = [
  ID,
  `  ${ID}  `,
  ` ${ID} `,
  ID.toUpperCase(),
  LINK,
  `${LINK}/?lang=it#settimana`,
  LINK.replace('unical.prod.up.cineca.it', 'UNICAL.PROD.UP.CINECA.IT'),
  LINK.replace('cineca.it/', 'cineca.it:443/'),
  LINK.replace('cineca.it/', 'cineca.it:8443/'),
  LINK.replace('https://', 'https://user:secret@'),
  LINK.replace('https:', 'http:'),
  LINK.replace('unical.prod.up.cineca.it', 'unical.prod.up.cineca.it.example.org'),
  'https://www.unical.it/didattica/orari',
  ' https://WWW.UNICAL.IT/Didattica/Orari?anno=2026#lezioni ',
  ' https://dimes.unical.it:443/orari/ ',
  'https://user@www.unical.it/orari',
  'https://unical.it.example.org/orari',
  'https://notunical.it/orari',
  'pagina senza indirizzo',
  `https://www.unical.it/${'a'.repeat(480)}`,
];

function referenceOrNull(value: string): string | null {
  try {
    return calendarReference(value);
  } catch {
    return null;
  }
}

function sourceOrLine(value: string): string {
  try {
    return sourceUrl(value);
  } catch {
    return value.trim();
  }
}

test('calendarRef gives the same id as calendarReference, null where it throws', () => {
  assert.equal(INPUTS.length, 20);
  for (const input of INPUTS) assert.equal(calendarRef(input), referenceOrNull(input), JSON.stringify(input));
  assert.equal(calendarRef(LINK), ID);
  assert.equal(calendarRef(ID.toUpperCase()), null);
  assert.equal(calendarRef(42), null);
});

test('sourceUrlLine gives the normalized url of sourceUrl, the trimmed line where it throws', () => {
  for (const input of INPUTS) assert.equal(sourceUrlLine(input), sourceOrLine(input), JSON.stringify(input));
  assert.equal(sourceUrlLine(' https://WWW.UNICAL.IT/Didattica/Orari?anno=2026#lezioni '), 'https://www.unical.it/Didattica/Orari?anno=2026');
  assert.equal(sourceUrlLine('https://notunical.it/orari'), 'https://notunical.it/orari');
});
