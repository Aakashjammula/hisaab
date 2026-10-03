// Shapes shared by services, ports and adapters. Money is always integer paise.

export type Id = string; // UUID v7

export interface User {
  id: Id;
  email: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface Category {
  id: Id;
  name: string;
  icon: string;
  color: string;
  locked: boolean;
}

export interface CategoryWithUsage extends Category {
  count: number;
  recent: number;
}

export interface Person {
  id: Id;
  name: string;
}

export interface PersonWithUsage extends Person {
  count: number;
  recent: number;
}

/** One person's part of a split expense. */
export interface Share {
  person: Person;
  amount: number;
}

export interface Expense {
  id: Id;
  paid: number;
  myShare: number;
  note: string | null;
  spentOn: string; // YYYY-MM-DD
  createdAt: string;
  category: Category;
  shares: Share[];   // empty for unsplit expenses and older splits without people
}

export interface ExpenseInput {
  paid: number;
  myShare: number;
  note: string | null;
  spentOn: string;
  category: string;          // name; created on the fly if missing
  categoryIcon: string | null;
  categoryColor: string | null;
  shares: { person: string; amount: number }[]; // person by name; created on the fly if missing
}

export interface CategoryInput {
  name?: string;
  icon?: string;
  color?: string;
}

/** A month (YYYY-MM) or a year (YYYY), with how much of it has passed. */
export interface Period {
  type: 'month' | 'year';
  key: string;
  start: string;   // inclusive YYYY-MM-DD
  end: string;     // exclusive YYYY-MM-DD
  units: number;   // days in the period
  elapsed: number; // days passed (0 for future periods)
  prev: string;    // previous period key
  today: string;
}
