// Ports: everything the services need from the outside world.
// Cloudflare implements these today (D1, Email Routing); AWS can implement them later (Postgres, SES)
// without touching core/ or services/. Every data method is scoped by userId.
import type { Category, CategoryInput, CategoryWithUsage, Expense, Id, Period, Person, PersonWithUsage, User } from '../core/types.ts';

// ---------- data ----------

export interface UserRepo {
  findByEmail(email: string): Promise<User | null>;
  findById(id: Id): Promise<User | null>;
  /** Creates the user and their default categories in one transaction. */
  createWithDefaults(user: { id: Id; email: string; createdAt: string }, categories: NewCategory[]): Promise<User>;
}

export interface NewCategory { id: Id; name: string; nameKey: string; icon: string; color: string; locked: boolean; createdAt: string }

export interface NewPerson { id: Id; name: string; nameKey: string; createdAt: string }

export interface NewExpense {
  id: Id; paid: number; myShare: number; note: string | null; spentOn: string; now: string;
  category: NewCategory; // inserted if no category with the same nameKey exists for the user
  shares: { person: NewPerson; amount: number }[]; // each person inserted if missing (by nameKey)
}

export interface ExpenseFilter { categoryId?: Id; personId?: Id }

export interface ExpenseRepo {
  listInRange(userId: Id, start: string, end: string, filter?: ExpenseFilter): Promise<Expense[]>;
  get(userId: Id, id: Id): Promise<Expense | null>;
  /** Ensures the category and people, then inserts the expense and its shares — atomically. */
  create(userId: Id, e: NewExpense): Promise<Expense>;
  /** Replaces fields and shares. Returns false when the expense doesn't exist for this user. */
  update(userId: Id, id: Id, e: Omit<NewExpense, 'id'>): Promise<boolean>;
  delete(userId: Id, id: Id): Promise<boolean>;
}

export interface CategoryRepo {
  list(userId: Id, recentSince: string): Promise<CategoryWithUsage[]>;
  get(userId: Id, id: Id): Promise<Category | null>;
  usedColors(userId: Id): Promise<Record<string, number>>;
  /** Throws AppError('conflict') when the name is taken. */
  create(userId: Id, c: NewCategory): Promise<Category>;
  update(userId: Id, id: Id, patch: CategoryInput & { nameKey?: string }): Promise<Category | null>;
  /** Moves its expenses to the user's locked "Other" category, then deletes. Returns moved count. */
  deleteMovingToOther(userId: Id, id: Id): Promise<number>;
}

export interface PersonRepo {
  list(userId: Id, recentSince: string): Promise<PersonWithUsage[]>;
  get(userId: Id, id: Id): Promise<Person | null>;
  /** Throws AppError('conflict') when the name is taken. */
  create(userId: Id, p: NewPerson): Promise<Person>;
  rename(userId: Id, id: Id, name: string, nameKey: string): Promise<Person | null>;
  /** Their shares go too, so those amounts become "unassigned". Returns false when not found. */
  delete(userId: Id, id: Id): Promise<boolean>;
}

export interface SummaryRepo {
  summary(userId: Id, p: Period): Promise<SummaryData>;
  categorySummary(userId: Id, categoryId: Id, p: Period): Promise<CategorySummaryData | null>;
}

export interface Bucket { k: string; amount: number; count?: number }
export interface SummaryData {
  totals: { mySpend: number; others: number; count: number };
  buckets: Bucket[];
  prevBuckets: Bucket[];
  byCategory: (Category & { amount: number; count: number })[];
  byPerson: (Person & { amount: number; count: number })[];
  baseline: { months: number; amount: number; byCategory: Record<Id, number> };
  trend: Bucket[];
  top: Expense[];
  splits: { count: number; paid: number; myShare: number };
}
export interface CategorySummaryData { category: Category; expenses: Expense[]; trend: Bucket[] }

// ---------- auth ----------

export interface Session { tokenHash: string; userId: Id; createdAt: string; lastSeenAt: string; expiresAt: string }

export interface SessionRepo {
  create(s: Session & { userAgent: string | null }): Promise<void>;
  get(tokenHash: string): Promise<Session | null>;
  touch(tokenHash: string, lastSeenAt: string, expiresAt: string): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  deleteAllForUser(userId: Id): Promise<void>;
  deleteExpired(now: string): Promise<void>;
}

export interface AuthCode { id: Id; email: string; codeHash: string; expiresAt: string; attempts: number }

export interface AuthCodeRepo {
  /** Stores a new code and invalidates any earlier unused codes for the email. */
  replace(code: AuthCode & { createdAt: string }): Promise<void>;
  latestActive(email: string, now: string): Promise<AuthCode | null>;
  incrementAttempts(id: Id): Promise<void>;
  consume(id: Id, now: string): Promise<boolean>;
}

// ---------- oauth (MCP connector) ----------

export interface OAuthClient { id: Id; name: string; redirectUris: string[]; createdAt: string }
export interface OAuthCode {
  codeHash: string; clientId: Id; userId: Id; redirectUri: string;
  codeChallenge: string; resource: string; userAgent: string | null; expiresAt: string;
}
export interface OAuthConnection {
  id: Id; userId: Id; clientId: Id; clientName: string;
  createdAt: string; lastUsedAt: string; expiresAt: string; userAgent: string | null;
}
export interface OAuthToken { tokenHash: string; connectionId: Id; kind: 'access' | 'refresh'; expiresAt: string; rotatedAt: string | null }

export interface OAuthRepo {
  createClient(c: OAuthClient): Promise<void>;
  getClient(id: Id): Promise<OAuthClient | null>;
  createCode(c: OAuthCode & { createdAt: string }): Promise<void>;
  /** Atomically marks the code consumed; returns it only if it was unconsumed and unexpired at `now`. */
  consumeCode(codeHash: string, now: string): Promise<OAuthCode | null>;
  createConnection(c: Omit<OAuthConnection, 'clientName'>): Promise<void>;
  getConnection(id: Id): Promise<OAuthConnection | null>;        // joins client name
  touchConnection(id: Id, lastUsedAt: string, expiresAt: string): Promise<void>;
  listConnections(userId: Id): Promise<OAuthConnection[]>;       // newest first
  /** Deletes the connection and (cascade) its tokens. Scoped by user; false when not found. */
  deleteConnection(userId: Id, id: Id): Promise<boolean>;
  deleteAllConnections(userId: Id): Promise<void>;
  addToken(t: OAuthToken): Promise<void>;
  getToken(tokenHash: string): Promise<OAuthToken | null>;
  /** Sets rotated_at only if it is still null; false if another request already rotated it. */
  markRotated(tokenHash: string, now: string): Promise<boolean>;
  deleteToken(tokenHash: string): Promise<void>;
  deleteExpired(now: string): Promise<void>;                      // codes, tokens, connections past expires_at
}

export interface RateLimiter {
  /** Counts a hit; returns 0 when allowed, otherwise seconds until the window resets. */
  hit(key: string, limit: number, windowSeconds: number, now: Date): Promise<number>;
  /** Current count in the window that contains `now` (does not count a hit). */
  count(key: string, windowSeconds: number, now: Date): Promise<number>;
}

// ---------- infrastructure ----------

export interface Mailer {
  send(message: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export interface Clock { now(): Date }
export interface IdGenerator { next(): Id }
