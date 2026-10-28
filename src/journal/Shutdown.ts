// Shutdown.ts — process-level registry of open journals: on exit/SIGINT/SIGTERM
// every open journal's WAL is drained so no acknowledged row is lost.

/** The minimal contract the registry needs from an open journal. */
interface WalDrainable {
  /** Flush the WAL synchronously (idempotent). */
  walDrain(): void;
}

export class Shutdown {
  private static readonly activeJournals = new Set<WalDrainable>();
  private static hooksInstalled = false;

  /** Register an open journal for WAL drain on process exit. */
  static track(journal: WalDrainable): void {
    Shutdown.activeJournals.add(journal);
    Shutdown.installHooks();
  }

  /** Unregister a closed journal. */
  static untrack(journal: WalDrainable): void {
    Shutdown.activeJournals.delete(journal);
  }

  private static installHooks(): void {
    if (Shutdown.hooksInstalled) return;
    Shutdown.hooksInstalled = true;

    const drainAll = (): void => {
      for (const j of [...Shutdown.activeJournals]) {
        try { j.walDrain(); } catch { /* exiting anyway */ }
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
}
