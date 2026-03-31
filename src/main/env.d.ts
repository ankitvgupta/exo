// Augment ImportMeta with Vite's import.meta.glob and import.meta.env
interface ImportMetaGlobOptions {
  eager?: boolean;
}

interface ImportMeta {
  glob<T = unknown>(pattern: string, options?: ImportMetaGlobOptions): Record<string, T>;
  readonly env: Record<string, string | undefined>;
}
