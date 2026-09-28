// LR-6 recovery: converts a version-4, version-5 or version-6 workspace back to the version-3 format so an older build can
// open it. Close Quant Research Office first. A copy of the file is written before anything changes.
// Usage from app/: pnpm exec tsx scripts/downgrade-workspace.ts "<path to workspace.sqlite>"
import { downgradeWorkspaceToV3 } from '../src/core/store';

const file = process.argv[2];
if (!file) {
  console.error('Give the path to workspace.sqlite.');
  process.exit(1);
}
const backup = downgradeWorkspaceToV3(file);
console.log(JSON.stringify({ downgraded: file, backup }));
