import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { authoredTemplates } from '../src/main/research-templates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDirectory = path.join(here, '..', 'research-templates');

test('the authored templates are versioned consistently and none of them is executed here', () => {
  const templates = authoredTemplates(templateDirectory);
  for (const template of templates) {
    assert.match(template.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
    assert.equal(template.file.startsWith(template.id + '.v' + template.version.split('.')[0]), true);
  }
  assert.throws(() => authoredTemplates(path.join(templateDirectory, 'nowhere')), /template directory is missing/);
  // The golden fixture directory holds data, not code, so it contributes no templates.
  assert.throws(() => authoredTemplates(path.join(templateDirectory, 'golden')), /No authored research templates/);
});
