import { readFile } from 'node:fs/promises';
import { classify } from './eligibility.mjs';
const rows = JSON.parse(await readFile(new URL('../inputs/records.json', import.meta.url), 'utf8'));
console.log(JSON.stringify(rows.map(classify), null, 2));
