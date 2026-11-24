import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryUrl, parseNews, programme, type NewsItem } from '../src/news/programme.js';

// Same shape as the University's news API, invented items.
const NOW = Date.UTC(2026, 10, 24, 12, 0);
const AVVISI = { id: 8, name: 'Avvisi' };
const NOTIZIE = { id: 9, name: 'Notizie UniCal' };

function item(id: number, title: string, start: string, categories: object[], extra: Record<string, unknown> = {}) {
  return {
    id: id + 1000,
    date_start: start,
    path: `/contents/news/view/${id}-notizia-di-prova/`,
    publication: { id, title, subheading: 'Un sottotitolo di prova', image: '/media/medias/2026/prova.webp', category_data: categories, content: '<p>Testo lungo</p>', ...extra },
  };
}

const answer = (...items: object[]) => ({ count: items.length, results: items });

test('keeps title, summary, time, kind, link and image of each item', () => {
  const [one] = parseNews(answer(item(101, 'Un avviso di prova', '2026-11-24T10:51:00+01:00', [AVVISI], { image: null })), NOW);
  assert.deepEqual(one, {
    id: 101,
    title: 'Un avviso di prova',
    summary: 'Un sottotitolo di prova',
    at: Date.UTC(2026, 10, 24, 9, 51),
    kinds: ['notice'],
    url: 'https://www.unical.it/contents/news/view/101-notizia-di-prova/',
    image: null,
  });
});

test('an item in two categories gets both kinds; unknown categories alone leave it out', () => {
  const items = parseNews(
    answer(
      item(1, 'Doppia', '2026-11-20T12:10:00+01:00', [NOTIZIE, AVVISI]),
      item(2, 'Solo altro', '2026-11-20T12:10:00+01:00', [{ id: 17, name: 'News' }]),
    ),
    NOW,
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.kinds]),
    [[1, ['notice', 'news']]],
  );
});

test('items with markup, odd links, bad dates or a future date are left out; odd images and summaries are dropped', () => {
  const items = parseNews(
    answer(
      item(1, 'Titolo <b>con tag</b>', '2026-11-20T12:10:00+01:00', [NOTIZIE]),
      { ...item(2, 'Link strano', '2026-11-20T12:10:00+01:00', [NOTIZIE]), path: 'https://altro.example/notizia/' },
      item(3, 'Data strana', 'ieri', [NOTIZIE]),
      item(4, 'Dal futuro', '2026-11-30T12:00:00+01:00', [NOTIZIE]),
      item(5, 'Buona', '2026-11-20T12:10:00+01:00', [NOTIZIE], { image: '/media/medias/2026/foto con spazi.webp', subheading: '' }),
    ),
    NOW,
  );
  assert.deepEqual(
    items.map((i) => [i.title, i.image, i.summary]),
    [['Buona', null, null]],
  );
});

test('an answer without a list gives no items', () => {
  assert.deepEqual(parseNews({ detail: 'Not found.' }, NOW), []);
  assert.deepEqual(parseNews(null, NOW), []);
});

test('the programme lists each item once, newest first', () => {
  const at = (id: number, ms: number): NewsItem => ({ id, title: `N${id}`, summary: null, at: ms, kinds: ['news'], url: 'u', image: null });
  const result = programme([[at(1, 10), at(2, 30)], [at(2, 30), at(3, 20)]], ['a', 'b'], NOW);
  assert.deepEqual(
    result.items.map((i) => i.id),
    [2, 3, 1],
  );
  assert.deepEqual([result.sources, result.checkedAt], [['a', 'b'], NOW]);
});

test('the category URL asks for the newest twenty in Italian', () => {
  assert.equal(categoryUrl(8), 'https://www.unical.it/api/news/by-context/1?page=1&page_size=20&lang=it&category=8');
});
