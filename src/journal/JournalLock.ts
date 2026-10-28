// JournalLock.ts — single-owner journal lockfile. The lock file records the
// owner's pid; stale locks (dead pid) are auto-reclaimed on acquire.

import fs from 'node:fs';
import ErrorManager from '../errors/ErrorManager.ts';
import type { LockMode } from '../core/types.ts';

export class JournalLock {
  /** Acquire the lock at lockPath; throws JRN_LOCKED when held by a live process. */
  static acquire(lockPath: string, mode: LockMode): void {
    if (mode === 'off') return;
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    let holderPid = -1;
    try {
      const info = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: number };
      if (typeof info.pid === 'number') holderPid = info.pid;
    } catch { /* Corrupted lockfile — consider stale */ }

    if (JournalLock.pidAlive(holderPid)) throw ErrorManager.make('JRN_LOCKED', { pid: holderPid, lockPath });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  }

  /** Release the lock when we are its owner. */
  static release(lockPath: string, mode: LockMode): void {
    if (mode === 'off') return;
    try {
      const info = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid?: number };
      if (info.pid === process.pid) fs.rmSync(lockPath, { force: true });
    } catch { /* Lock already gone */ }
  }

  /** True when pid names a live process (EPERM = alive but owned by another user). */
  private static pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
}
