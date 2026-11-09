// Closed lists shared with the database enums (supabase/migrations).
export const ROLES = ['student', 'moderator', 'admin'] as const;
export type AppRole = (typeof ROLES)[number];

export const REQUEST_KINDS = ['room_occupied', 'lesson_not_held', 'room_closed', 'issue'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const ISSUE_CATEGORIES = [
  'bagni',
  'proiettore',
  'prese',
  'riscaldamento',
  'aria_condizionata',
  'pulizia',
  'macchinette',
  'wifi',
  'arredi',
  'altro',
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];
