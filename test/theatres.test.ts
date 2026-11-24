import { test } from 'node:test';
import assert from 'node:assert/strict';
import { romeInstant, romeMidnight } from '../src/availability/time.js';
import { isoDay } from '../src/domain/primitives.js';
import { PTU_PAGE, SEASON_PAGE, parseShows, programme, seasonLink } from '../src/theatres/programme.js';

// Same shape as the University's pages, invented shows.
const FROM = isoDay('2026-11-24');
const day = (d: string) => isoDay(d);

function show(title: string, lines: string[], poster: string | null = '/media/medias/2026/Locandina_Prova.webp'): string {
  const image = poster === null ? '' : `<div class="col-12 col-lg-3"><a href="${poster}"><img alt="Locandina" class="mw-100" loading="lazy" src="${poster}"/></a></div>`;
  return `<hr class="my-4"/><div class="row mb-4"><link href="x.css" rel="stylesheet"/>${image}<div class="col-12 col-lg-8 ps-lg-4"><h4>${title}</h4><p>${lines.join('<br/>')}</p></div></div>`;
}

const page = (...shows: string[]) => `<html><body><h4>Prossimi spettacoli</h4>${shows.join('\n')}</body></html>`;

test('reads title, theatre, poster and the days from today on, with the time of the show', () => {
  const html = page(
    show('UN CONCERTO DI PROVA', ['TAU - Teatro Auditorium Unical', 'Giovedì 26 novembre 2026', 'ore 21:00']),
    show('PASSATO', ['TAU - Teatro Auditorium Unical', 'sabato 24 ottobre 2026&nbsp;', 'ore 21:00']),
  );
  assert.deepEqual(parseShows(html, SEASON_PAGE, FROM), [
    {
      title: 'UN CONCERTO DI PROVA',
      theatre: 'tau',
      url: SEASON_PAGE,
      poster: 'https://www.unical.it/media/medias/2026/Locandina_Prova.webp',
      dates: [{ at: romeInstant(day('2026-11-26'), 21, 0), timed: true, note: null }],
    },
  ]);
});

test('a show on more days keeps a note per day; the small theatre is recognised by its name', () => {
  const html = page(
    show('DUE SERE', [
      'PTU - <a href="https://maps.example">Piccolo Teatro Unical</a>',
      'mercoledì 2 dicembre 2026 <i>Gratuito per studenti</i>',
      'giovedì 3 dicembre 2026 <i>Aperto al pubblico </i>',
      'ore 21:00',
    ]),
  );
  const [due] = parseShows(html, PTU_PAGE, FROM);
  assert.deepEqual(
    [due?.theatre, due?.dates.map((d) => d.note)],
    ['ptu', ['Gratuito per studenti', 'Aperto al pubblico']],
  );
});

test('a time with letters for zeros is read; without a time the day stays, at midnight and marked', () => {
  const html = page(
    show('ORA STORTA', ['TAU', 'Sabato 21 novembre 2026', 'Martedì 1 dicembre 2026', 'ore 21:oo']),
    show('SENZA ORA', ['TAU', 'Domenica 20 dicembre 2026']),
  );
  const [storta, senza] = parseShows(html, SEASON_PAGE, FROM);
  assert.deepEqual(storta?.dates, [{ at: romeInstant(day('2026-12-01'), 21, 0), timed: true, note: null }]);
  assert.deepEqual(senza?.dates, [{ at: romeMidnight(day('2026-12-20')), timed: false, note: null }]);
});

test('cancelled shows, shows without a theatre or a valid day, and markup in titles are left out', () => {
  const html = page(
    show('CANTANTE - EVENTO ANNULLATO', ['TAU', 'Mercoledì 18 novembre 2027', 'ore 21:00']),
    show('ALTROVE', ['Teatro di un altra città', 'Lunedì 7 dicembre 2026', 'ore 21:00']),
    show('DATA IMPOSSIBILE', ['TAU', 'Lunedì 31 febbraio 2027', 'ore 21:00']),
    show('&lt;b&gt;Strano', ['TAU', 'Lunedì 7 dicembre 2026', 'ore 21:00']),
  );
  assert.deepEqual(parseShows(html, SEASON_PAGE, FROM), []);
});

test('quotes around the whole title go, quotes inside stay; a poster outside the University media is not kept', () => {
  const html = page(
    show('&quot;Lo Spettacolo&quot;', ['TAU', 'Lunedì 7 dicembre 2026', 'ore 21:00'], '/altro/locandina.webp'),
    show('ATTORE &quot;Il Titolo&quot;', ['TAU', 'Martedì 8 dicembre 2026', 'ore 21:00']),
  );
  assert.deepEqual(
    parseShows(html, SEASON_PAGE, FROM).map((s) => [s.title, s.poster !== null]),
    [
      ['Lo Spettacolo', false],
      ['ATTORE "Il Titolo"', true],
    ],
  );
});

test('the season link comes from the theatres page, only for a season page of the University', () => {
  assert.equal(
    seasonLink('<a href="https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/stagione-teatrale-2027-28/">Stagione</a>'),
    'https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/stagione-teatrale-2027-28/',
  );
  assert.equal(seasonLink('<a href="https://evil.example/campus/vivere-il-campus/teatri-e-cinema/stagione-teatrale-2027-28/">x</a>'), null);
  assert.equal(seasonLink('<p>niente</p>'), null);
});

test('the programme puts both theatres together in the order of their first day', () => {
  const at = (d: string) => ({ at: romeInstant(day(d), 21, 0), timed: true, note: null });
  const tau = [{ title: 'Dopo', theatre: 'tau' as const, url: SEASON_PAGE, poster: null, dates: [at('2026-12-09')] }];
  const ptu = [{ title: 'Prima', theatre: 'ptu' as const, url: PTU_PAGE, poster: null, dates: [at('2026-12-02')] }];
  const p = programme([tau, ptu], [SEASON_PAGE, PTU_PAGE], 5);
  assert.deepEqual(
    [p.checkedAt, p.shows.map((s) => s.title)],
    [5, ['Prima', 'Dopo']],
  );
});
