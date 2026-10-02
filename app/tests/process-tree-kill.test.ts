import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnTreeKillable } from '../src/main/local-cli-exec.js';
import { removeTreeSync } from '../src/main/fsx.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A provider CLI runs its tools as child processes. Cancelling or timing out the CLI must end
// them too. On Windows a plain kill() stops only the direct child, and a native CLI (unlike a
// Node parent) does not take its children down with it — cmd.exe stands in for such a CLI here.
test(
  'killing an office-spawned CLI ends the processes it started (Windows process tree)',
  { skip: process.platform !== 'win32' },
  async t => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qro-tree-kill-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    writeFileSync(
      path.join(dir, 'grandchild.js'),
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`,
    );
    writeFileSync(path.join(dir, 'cli.cmd'), `@"${process.execPath}" "${path.join(dir, 'grandchild.js')}"\r\n`);
    const child = spawnTreeKillable('cmd.exe', ['/d', '/c', path.join(dir, 'cli.cmd')], {
      cwd: dir,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const started = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < started) await new Promise(resolve => setTimeout(resolve, 50));
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'));
    t.after(() => {
      if (alive(grandchildPid)) process.kill(grandchildPid);
      removeTreeSync(dir);
    });
    assert.ok(alive(grandchildPid), 'the tool process runs before the kill');
    const exited = new Promise(resolve => child.on('exit', resolve));
    const closed = new Promise(resolve => child.on('close', resolve));
    assert.equal(child.kill(), true);
    await exited;
    await closed;
    const deadline = Date.now() + 5000;
    while (alive(grandchildPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(alive(grandchildPid), false, 'the tool process does not outlive the CLI kill');
  },
);
