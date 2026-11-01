export type ConfirmationOutcome = 'approved' | 'denied' | 'timeout' | 'cancelled';

export interface ConfirmationUi {
  open(id: string): Promise<number | undefined>;
  close(windowId: number): Promise<void>;
}

interface Pending {
  id: string;
  requestId: string;
  prompt: string;
  windowId: number | undefined;
  settle: (outcome: ConfirmationOutcome) => void;
}

/**
 * Website-requested destructive actions wait here for an answer given in a window
 * the extension owns. The website cannot open that page or answer it, because the
 * page is not web-accessible and decisions are only accepted from extension pages.
 * One at a time, so a page cannot flood the user with prompts.
 */
export class ConfirmationManager {
  private pending: Pending | null = null;

  constructor(
    private readonly ui: ConfirmationUi,
    private readonly timeoutMs = 45_000,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  get busy(): boolean {
    return this.pending !== null;
  }

  async request(prompt: string, requestId: string): Promise<ConfirmationOutcome> {
    const id = this.createId();
    const outcome = new Promise<ConfirmationOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish(id, 'timeout'), this.timeoutMs);
      // Service workers sleep after 30 idle seconds; API calls keep this one awake.
      const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
      this.pending = {
        id,
        requestId,
        prompt,
        windowId: undefined,
        settle: (result) => {
          clearTimeout(timer);
          clearInterval(keepAlive);
          resolve(result);
        },
      };
    });

    try {
      const windowId = await this.ui.open(id);
      if (this.pending?.id === id) this.pending.windowId = windowId;
      else if (windowId !== undefined) await this.ui.close(windowId);
    } catch {
      this.finish(id, 'denied');
    }
    return outcome;
  }

  getPrompt(id: string): string | null {
    return this.pending?.id === id ? this.pending.prompt : null;
  }

  decide(id: string, approved: boolean): void {
    this.finish(id, approved ? 'approved' : 'denied');
  }

  cancelRequest(requestId: string): void {
    if (this.pending?.requestId === requestId) this.finish(this.pending.id, 'cancelled');
  }

  /** Closing the window counts as declining. */
  handleWindowClosed(windowId: number): void {
    if (this.pending?.windowId === windowId) this.finish(this.pending.id, 'denied');
  }

  private finish(id: string, outcome: ConfirmationOutcome): void {
    const pending = this.pending;
    if (pending?.id !== id) return;
    this.pending = null;
    pending.settle(outcome);
    if (pending.windowId !== undefined) void this.ui.close(pending.windowId).catch(() => undefined);
  }
}
