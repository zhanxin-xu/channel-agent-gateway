/** The run lock: one agent run per chat at a time, held on the session row. */
import crypto from "node:crypto";
import type { ChatStore } from "../store/index.js";

export const LOCK_TTL_MS = 60_000;
const LOCK_RENEW_MS = 20_000;

/** A chat's run lock: a lease that expires unless renewed, so a killed run can't hold it forever. */
export class RunLock {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private store: ChatStore,
    private chat: string,
    readonly owner: string = crypto.randomUUID(),
  ) {}

  async acquire(): Promise<boolean> {
    const ok = await this.store.lock(this.chat, this.owner, LOCK_TTL_MS, "acquire");
    if (ok) this.hold();
    return ok;
  }

  /** Start renewing a lock this owner already holds (the webhook took it during ingest). */
  hold() {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.renew(), LOCK_RENEW_MS);
    this.timer.unref?.();
  }

  private async renew() {
    try {
      if (!(await this.store.lock(this.chat, this.owner, LOCK_TTL_MS, "renew"))) console.warn(`[lock] lost ${this.chat}`);
    } catch (err) {
      console.warn(`[lock] renew failed for ${this.chat}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.store.lock(this.chat, this.owner, LOCK_TTL_MS, "release");
  }
}
