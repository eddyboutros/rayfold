export const PACKAGES: ReadonlyArray<{
  dir: string;
  bin?: Record<string, string>;
  copy?: string[];
  readme?: string;
  exports?: Record<string, string>;
}>;
