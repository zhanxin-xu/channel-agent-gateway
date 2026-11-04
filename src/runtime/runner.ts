/**
 * The run, for whoever holds a chat's lock: turn after turn, take every
 * message not handled yet, run the agent loop on the log (agent/loop.ts),
 * move the cursor. One run per chat at a time, so several people talking at
 * once get one answer, and messages that arrive mid-turn reach the running loop.
 *
 * Handing over: ingress logs and tries the lock in one transaction; a run
 * releases the lock, then checks for work once more, so a message can't fall
 * in the gap. A run about to run out of time with work left hands over to
 * /api/worker (handoff.ts).
 */
import type { ChannelAdapter } from "../channels/types.js";
import { config } from "../config.js";
import { LAST_STEP_RESERVE_MS, runTurn } from "../agent/loop.js";
import { SYSTEM_PROMPT } from "../agent/system-prompt.js";
import { recoverOpenTurn } from "../conversation/recovery.js";
import { Session } from "../conversation/session.js";
import { getStore, type ChatStore } from "../store/index.js";
import { makeToolContext } from "./context.js";
import { handOff } from "./handoff.js";
import { RunLock } from "./lock.js";
import { Outbox } from "./outbox.js";
import { wakeFor } from "./sampler.js";
import type { ChatMeta } from "./types.js";

export type { ChatMeta };

/** A new turn starts only with this much time left; otherwise the run hands over to /api/worker. */
const HANDOFF_BELOW_MS = LAST_STEP_RESERVE_MS + 30_000;

/**
 * Run the agent for a chat if no one else is: take the lock, handle turns
 * until nothing is pending, release, look once more. Returns false when
 * another run holds the lock.
 */
export async function runChat(
  adapter: ChannelAdapter,
  meta: ChatMeta,
  opts: { collect?: string[]; ambientClaimed?: boolean; deadline?: number; lock?: RunLock } = {},
): Promise<boolean> {
  const store = getStore();
  const chatKey = `${meta.channel}:${meta.conversationId}`;
  // Every round of this function shares one deadline: when the platform kills it.
  const deadline = opts.deadline ?? Date.now() + config.agent.maxDurationSeconds * 1000;
  let ambientClaimed = opts.ambientClaimed ?? false;
  for (let round = 0; ; round++) {
    // The webhook's ingest may already have taken the lock for this run.
    let lock: RunLock;
    if (round === 0 && opts.lock) {
      lock = opts.lock;
      lock.hold();
    } else {
      lock = new RunLock(store, chatKey);
      if (!(await lock.acquire())) return round > 0;
    }
    let outcome: "idle" | "handoff";
    let session: Session | null;
    try {
      ({ outcome, session } = await drain(store, adapter, meta, { collect: opts.collect, ambientClaimed, deadline }));
    } finally {
      await lock.release();
    }
    if (outcome === "handoff") {
      await handOff(meta, chatKey);
      return true;
    }
    if (!session) return true;
    // Something may have arrived after the last check, while its webhook couldn't get the lock.
    // (If another run took over meanwhile, a stale read only costs a lock attempt: that run handles it.)
    await session.refresh();
    const trigger = await wakeFor(store, chatKey, session.messagesAfter(session.cursor), false);
    if (!trigger) return true;
    ambientClaimed = trigger === "ambient";
  }
}

async function drain(
  store: ChatStore,
  adapter: ChannelAdapter,
  meta: ChatMeta,
  opts: { collect?: string[]; ambientClaimed: boolean; deadline: number },
): Promise<{ outcome: "idle" | "handoff"; session: Session | null }> {
  const chatKey = `${meta.channel}:${meta.conversationId}`;
  const deadline = opts.deadline;
  const session = await Session.open(store, chatKey);
  if (!session) return { outcome: "idle", session };

  // A run that was killed left its turn open: close it the way dsh does.
  const fixes = recoverOpenTurn(session.events);
  if (fixes.length) {
    console.warn(`[runner] ${chatKey}: closing an interrupted turn`);
    await session.append(...fixes);
  }

  const outbox = new Outbox(store, adapter, session, meta, opts.collect);
  const turnState = { main: -1 };
  const { ctx, endRun } = makeToolContext(adapter, meta, chatKey, deadline, outbox, turnState, opts.collect);
  let ambientClaimed = opts.ambientClaimed;

  const done = (outcome: "idle" | "handoff") => ({ outcome, session });
  try {
    for (let turns = 0; ; turns++) {
      // Session.open just read the log; after a turn, read what arrived during it.
      if (turns > 0) await session.refresh();
      const pending = session.messagesAfter(session.cursor);
      const trigger = await wakeFor(store, chatKey, pending, ambientClaimed);
      if (!trigger) return done("idle");
      const direct = trigger === "direct";
      ambientClaimed = false;
      if (deadline - Date.now() < HANDOFF_BELOW_MS) return done("handoff");

      // Replies go by default to the newest @ (else newest) message that can still take one.
      const main = (await findLastAsync(pending.filter((m) => m.data.mentioned), (m) => outbox.canReply(m.seq))) ??
        (await findLastAsync(pending, (m) => outbox.canReply(m.seq))) ??
        pending.at(-1)!;
      turnState.main = main.seq;
      ctx.sent = [];
      ctx.chat.sender = main.data.sender;
      const turn = await session.nextTurn();
      const started = Date.now();
      try {
        const result = await runTurn({
          session,
          ctx,
          systemPrompt: [SYSTEM_PROMPT, adapter.promptHint].filter(Boolean).join("\n\n"),
          turn,
          trigger,
          pending,
          main,
          canReply: () => outbox.canReply(main.seq),
        });
        if (direct && ctx.sent.length === 0 && result.text) await ctx.send({ kind: "text", text: result.text }).catch(() => {});
        await session.setCursor(result.handledUpTo);
        console.log(
          `[turn] ${chatKey} #${turn} ${direct ? "direct" : "ambient"} pending=${pending.length} steps=${result.steps} ` +
            `end=${result.reason} sent=${ctx.sent.length} input=${result.usage.input} cached=${result.usage.cached} ` +
            `reasoning=${result.usage.reasoning} ms=${Date.now() - started}`,
        );
      } catch (err) {
        console.error(`[runner] turn ${turn} failed for ${chatKey}`, err);
        await session.setCursor(pending.at(-1)!.seq);
        if (direct && ctx.sent.length === 0) await ctx.send({ kind: "text", text: "抱歉，处理消息时出错了，请稍后再试。" }).catch(() => {});
      }
    }
  } finally {
    await endRun();
  }
}

async function findLastAsync<T>(items: T[], ok: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (let i = items.length - 1; i >= 0; i--) if (await ok(items[i]!)) return items[i];
  return undefined;
}
