import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Feature 10 D-12: the shipped bundle contains no `eval` and no `Function` (`PRD.md` s.75). Runs as the
 * last step of the web and API builds, over what was actually emitted, so a dependency that starts
 * compiling code at run time fails the build instead of arriving unnoticed.
 *
 * Text matching on purpose: an aliased `eval` would escape it, and that is accepted, because the source
 * guard and the interpreter's own tests cover the code we write.
 */

export interface BundleOccurrence {
  readonly file: string;
  readonly snippet: string;
}

/**
 * A bare `Function(` counts only with a literal first argument: TypeBox declares a type builder named
 * `Function` that takes schemas, and unminified output keeps that name.
 */
const FORBIDDEN =
  /(?<![\w$.])(?:eval\s*\(|new\s+Function\s*\(|Function\s*\(\s*['"`])|(?:globalThis|window|self)\.(?:eval|Function)\s*\(/g;
const SNIPPET_RADIUS = 40;

/** Every occurrence in one file's text, with its surrounding text, on one line. */
export function occurrencesIn(file: string, text: string): readonly BundleOccurrence[] {
  return [...text.matchAll(FORBIDDEN)].map((match) => ({
    file,
    snippet: text
      .slice(
        Math.max(0, match.index - SNIPPET_RADIUS),
        match.index + match[0].length + SNIPPET_RADIUS,
      )
      .replace(/\s+/g, ' '),
  }));
}

function javascriptFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return javascriptFiles(path);
    return /\.(?:m?js|cjs)$/.test(name) ? [path] : [];
  });
}

export function scanDirectory(directory: string): readonly BundleOccurrence[] {
  return javascriptFiles(directory).flatMap((path) =>
    occurrencesIn(path, readFileSync(path, 'utf8')),
  );
}

/**
 * Occurrences a build may ship, each by a text that identifies it. Web: the one webpack global-object
 * shim in PowerSync's vendored SQLite worker, which compiles a constant string. API: Fastify, Ajv,
 * `find-my-way`, and `fast-json-stringify` compile route and schema code at boot. Package content
 * reaches neither. Anything else fails the build.
 */
export const ALLOWED_BY_BUILD: Readonly<Record<string, readonly string[]>> = {
  web: ["return this || new Function('return this')()"],
  api: [
    'makeValidate = new Function(',
    'makeSerialize = new Function(',
    'makeParse = new Function(',
    'contextFunc = new Function(',
    'return new Function(serializeFuncCode',
    'new Function("NullObject"',
    '_getHandlerMatchingConstraints = new Function(',
    'matchPrefix = new Function(',
    'deriveSyncConstraints = new Function(',
  ],
};

export function disallowed(
  occurrences: readonly BundleOccurrence[],
  allowed: readonly string[],
): readonly BundleOccurrence[] {
  return occurrences.filter(
    (occurrence) => !allowed.some((text) => occurrence.snippet.includes(text)),
  );
}

if (import.meta.main) {
  const [build, directory] = process.argv.slice(2);
  const allowed = build === undefined ? undefined : ALLOWED_BY_BUILD[build];
  if (allowed === undefined || directory === undefined) {
    console.error('usage: bundle-check.ts <web|api> <directory>');
    process.exit(2);
  }
  const occurrences = scanDirectory(directory);
  const refused = disallowed(occurrences, allowed);
  if (refused.length > 0) {
    for (const { file, snippet } of refused) console.error(`${file}: ${snippet}`);
    console.error(`bundle check failed: ${refused.length} use(s) of eval or Function.`);
    process.exit(1);
  }
  console.log(`bundle check (${build}): ${occurrences.length} allowed occurrence(s), none other.`);
}
