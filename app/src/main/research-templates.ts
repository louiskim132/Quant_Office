import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The authored template versions this build ships, and what a receipt claiming one must match.
 *
 * The office authors, exports and hosts these scripts; it never runs them on user research. So this
 * module reads them only to hash them, and the parser below checks a receipt's claims against those
 * hashes. Nothing here executes, imports or evaluates uploaded code — a receipt is a document about a
 * run, and treating it as anything more is how a submitted file becomes a program.
 */

export type TemplateId = 'data' | 'diagnostics' | 'portfolio' | 'cost';
export interface AuthoredTemplate {
  id: TemplateId;
  version: string;
  file: string;
  sha256: string;
}

const NAME = /^(data|diagnostics|portfolio|cost)\.v([0-9]+)\.py$/;

/** Every template version on disk. A directory with none is a build problem, not an empty catalogue. */
export function authoredTemplates(directory: string): AuthoredTemplate[] {
  if (!existsSync(directory)) throw new Error(`The research template directory is missing: ${directory}`);
  const templates = readdirSync(directory)
    .map(name => {
      const match = NAME.exec(name);
      if (!match) return null;
      const bytes = readFileSync(path.join(directory, name));
      // The major version lives in the filename; the exact patch version is declared inside the script,
      // so a receipt naming 1.0.0 cannot be satisfied by a file that says something else.
      const declared = /TEMPLATE_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/.exec(bytes.toString('utf8'));
      if (!declared) throw new Error(`${name} does not declare a TEMPLATE_VERSION.`);
      if (declared[1].split('.')[0] !== match[2])
        throw new Error(`${name} declares version ${declared[1]}, which does not match its filename.`);
      return {
        id: match[1] as TemplateId,
        version: declared[1],
        file: name,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    })
    .filter((item): item is AuthoredTemplate => item !== null);
  if (!templates.length) throw new Error(`No authored research templates were found in ${directory}.`);
  return templates.sort((a, b) => a.file.localeCompare(b.file));
}
