// shutdown.ts — process-level registry of open journals: on exit/SIGINT/SIGTERM
// every open journal's WAL is drained so no acknowledged row is lost.

import type { Journal } from './Journal.ts';

const activeJournals = new Set<Journal>();
let shutdownHooksInstalled = false;

/** Register an open journal for WAL drain on process exit. */
export function trackJournal(journal: Journal): void {
  activeJournals.add(journal);
  installShutdownHooks();
}

/** Unregister a closed journal. */
export function untrackJournal(journal: Journal): void {
  activeJournals.delete(journal);
}

function installShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;

  const drainAll = (): void => {
    for (const j of [...activeJournals]) {
      try { j._walDrain(); } catch { /* exiting anyway */ }
    }
  };

  process.on('exit', drainAll);
  const rekill = (sig: NodeJS.Signals): void => {
    drainAll();
    process.kill(process.pid, sig);
  };
  process.once('SIGINT', () => rekill('SIGINT'));
  process.once('SIGTERM', () => rekill('SIGTERM'));
}
