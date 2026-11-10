// Look and font of the page from ?tema= and ?font= (whitelists only); ?confronto=1 adds selectors to compare them.
import { el } from './ui.js';

// "attuale" is the original look, kept so it can be switched back with ?tema=attuale.
export const THEMES = ['essenziale', 'attuale'];
export const FONTS = ['atkinson', 'sistema'];
const DEFAULT_THEME = 'essenziale';
const FONT_LABELS = { atkinson: 'Atkinson Hyperlegible', sistema: 'Sistema' };

const params = new URLSearchParams(location.search);
export const theme = THEMES.includes(params.get('tema')) ? params.get('tema') : DEFAULT_THEME;
const DEFAULT_FONT = theme === 'attuale' ? 'sistema' : 'atkinson';
export const font = FONTS.includes(params.get('font')) ? params.get('font') : DEFAULT_FONT;
const compare = params.get('confronto') === '1';

document.documentElement.dataset.theme = theme;
document.documentElement.dataset.font = font;

// Links between the map and the admin page keep the chosen look.
export function themed(path) {
  const query = new URLSearchParams();
  if (theme !== DEFAULT_THEME) query.set('tema', theme);
  if (font !== DEFAULT_FONT) query.set('font', font);
  if (compare) query.set('confronto', '1');
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

function picker(label, name, values, current, text) {
  const select = el('select', { name }, values.map((key) => el('option', { value: key }, text(key))));
  select.value = current;
  return el('label', {}, label, select);
}

// The page changes only on "Applica", never while moving through the options.
function addSwitch() {
  const form = el(
    'form',
    { className: 'theme-switch', 'aria-label': 'Confronto stili' },
    picker('Stile', 'tema', THEMES, theme, (key) => key.charAt(0).toUpperCase() + key.slice(1)),
    picker('Font', 'font', FONTS, font, (key) => FONT_LABELS[key]),
    el('button', { type: 'submit' }, 'Applica'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = new URL(location.href);
    url.searchParams.set('tema', form.elements.tema.value);
    url.searchParams.set('font', form.elements.font.value);
    url.searchParams.set('confronto', '1');
    location.assign(url.href);
  });
  document.body.append(form);
}

if (compare) addSwitch();
