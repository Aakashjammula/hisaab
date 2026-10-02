export type AuthMode = 'closed' | 'invite' | 'open';

export interface AppConfig {
  appName: string;
  timeZone: string;
  auth: {
    /** closed: only allowedEmails · invite: allowedEmails can join, existing users stay · open: anyone */
    mode: AuthMode;
    allowedEmails: string[];
    secret: string;
    codeTtlMinutes: number;
    maxCodeAttempts: number;
    sessionIdleDays: number;
    sessionMaxDays: number;
  };
}

export const AUTH_DEFAULTS = { codeTtlMinutes: 10, maxCodeAttempts: 5, sessionIdleDays: 30, sessionMaxDays: 90 } as const;

/** Categories every new user starts with. "Other" is locked: deleted categories' expenses move there. */
export const DEFAULT_CATEGORIES = [
  { name: 'Food', icon: 'utensils', color: 'orange' },
  { name: 'Groceries', icon: 'shopping-cart', color: 'green' },
  { name: 'Travel', icon: 'train-front', color: 'blue' },
  { name: 'Shopping', icon: 'shopping-bag', color: 'teal' },
  { name: 'Bills', icon: 'receipt', color: 'amber' },
  { name: 'Entertainment', icon: 'clapperboard', color: 'pink' },
  { name: 'Health', icon: 'pill', color: 'red' },
  { name: 'Other', icon: 'tag', color: 'slate', locked: true },
] as const;
