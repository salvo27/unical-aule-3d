// Department layouts of the pdf source. A new layout adds its profile here and its section in config/pdf.json.
import { discagProfile } from './discag.js';
import { disuProfile } from './disu.js';
import type { PdfProfile } from './runner.js';

export const PROFILES: readonly PdfProfile[] = [discagProfile, disuProfile];
