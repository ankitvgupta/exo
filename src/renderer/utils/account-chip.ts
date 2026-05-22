// Small visual chip representing which account a thread belongs to in the
// unified "All Inboxes" view. Deterministic from the account email so the
// same account always gets the same color across renders and restarts.

const PALETTE: string[] = [
  "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300",
  "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300",
  "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300",
  "bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300",
  "bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300",
  "bg-teal-100 dark:bg-teal-900/40 text-teal-700 dark:text-teal-300",
  "bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300",
  "bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300",
];

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function accountChipFor(
  email: string | undefined,
): { label: string; colorClass: string; title: string } | undefined {
  if (!email) return undefined;
  const local = email.split("@")[0] ?? email;
  const label = local.slice(0, 1).toUpperCase();
  const colorClass = PALETTE[hashString(email) % PALETTE.length];
  return { label, colorClass, title: email };
}
