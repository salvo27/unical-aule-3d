import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CINEMA_PAGE, TICKETS, parseFilms, parseTimes, programme } from '../src/cinema/programme.js';

// Same shape as the cinema's page, invented films.
const SITE = 'https://cosenzacinema.it';
const POSTER = (file: string) => `${SITE}/wp-content/uploads/2026/11/${file}`;

function film(id: number, slug: string, title: string, days: string[], poster: string | null = POSTER(`${slug}.jpg`)): string {
  const image = poster === null ? '' : `<div class="amy-movie-item-poster"> <a href="${SITE}/movie/${slug}/"> <img decoding="async" src="${poster}"> </a> </div>`;
  return `<div class="amy-movie-item row"> <div class="amy-movie-item-inner"> ${image}
    <h3 class="amy-movie-field-title"><a href="${SITE}/movie/${slug}/">${title}</a></h3>
    <div class="amy-movie-item-showtimes-inner"> <select name="timelist" class="timelist" data-movie="${id}">
    ${days.map((d) => `<option value="${d}">${d.split('-').reverse().join('/')}</option>`).join(' ')} </select>
    <div class="amy-movie-item-time-list"> <span class="intro-time">19:15</span> </div> </div> </div> </div>`;
}

const page = (...films: string[]) => `<html><body><div class="amy-movie-showtimews-daily-2">${films.join('\n')}</div></body></html>`;

test('reads each film with its link, poster and days in order', () => {
  const html = page(film(11, 'il-film-di-prova', 'Il Film di Prova', ['2026-11-25', '2026-11-24']), film(12, 'senza-locandina', 'Senza Locandina', ['2026-11-24'], null));
  assert.deepEqual(parseFilms(html), [
    { id: '11', title: 'Il Film di Prova', url: `${SITE}/movie/il-film-di-prova/`, poster: POSTER('il-film-di-prova.jpg'), days: ['2026-11-24', '2026-11-25'] },
    { id: '12', title: 'Senza Locandina', url: `${SITE}/movie/senza-locandina/`, poster: null, days: ['2026-11-24'] },
  ]);
});

test('decodes the entities of titles and refuses markup or titles too long', () => {
  const html = page(
    film(11, 'alba', 'L&rsquo;Alba &amp; il Tramonto, citt&agrave;', ['2026-11-24']),
    film(12, 'strano', '&lt;b&gt;Strano', ['2026-11-24']),
    film(13, 'lungo', 'X'.repeat(121), ['2026-11-24']),
  );
  assert.deepEqual(
    parseFilms(html).map((f) => f.title),
    ['L’Alba & il Tramonto, città'],
  );
});

test('a poster or a film page of another site, a repeated film or an impossible day are not kept', () => {
  const html = page(
    film(11, 'buono', 'Buono', ['2026-11-24', '2026-02-30'], 'https://evil.example/wp-content/uploads/2026/11/x.jpg'),
    film(11, 'doppione', 'Doppione', ['2026-11-24']),
    film(12, 'altro', 'Altro', ['2026-11-24']).replace(`${SITE}/movie/altro/">Altro`, 'https://evil.example/movie/altro/">Altro'),
  );
  assert.deepEqual(
    parseFilms(html).map((f) => [f.title, f.poster, f.days]),
    [['Buono', null, ['2026-11-24']]],
  );
});

test('reads the times of the times call, escaped as JSON or not, without repeats and in order', () => {
  const json = JSON.stringify('<span class="intro-time">21:45</span>\n<span class="intro-time">17:15</span>\n<span class="intro-time">17:15</span><a class="button" href="https://x">Biglietto</a>');
  assert.deepEqual(parseTimes(json), [17 * 60 + 15, 21 * 60 + 45]);
  assert.deepEqual(parseTimes('<span class="intro-time">9.30</span><span class="intro-time">25:00</span>'), [9 * 60 + 30]);
  assert.deepEqual(parseTimes('"Nessun orario"'), []);
});

test('the programme leaves out films without shows and puts the first show first', () => {
  const films = [
    { title: 'Dopo', url: `${SITE}/movie/dopo/`, poster: null },
    { title: 'Prima', url: `${SITE}/movie/prima/`, poster: null },
    { title: 'Senza', url: `${SITE}/movie/senza/`, poster: null },
  ];
  const shows = new Map([
    [`${SITE}/movie/dopo/`, [{ at: 300, room: null, url: null }, { at: 200, room: null, url: null }]],
    [`${SITE}/movie/prima/`, [{ at: 100, room: null, url: null }]],
  ]);
  const p = programme(films, shows, 50);
  assert.deepEqual([p.source, p.tickets, p.checkedAt], [CINEMA_PAGE, TICKETS, 50]);
  assert.deepEqual(
    p.films.map((f) => [f.title, f.shows.map((s) => s.at)]),
    [
      ['Prima', [100]],
      ['Dopo', [200, 300]],
    ],
  );
});

test('a page with another layout gives no films, not an error', () => {
  assert.deepEqual(parseFilms('<html><body><p>Manutenzione</p></body></html>'), []);
  assert.deepEqual(parseFilms(''), []);
});
