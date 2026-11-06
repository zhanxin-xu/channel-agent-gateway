/**
 * The run, for whoever holds a chat's lock: turn after turn, take every
 * message not handled yet, run the agent loop on the log (agent/loop.ts),
 * move the cursor. One run per chat at a time, so several people talking at
 * once get one answer, and messages that arrive mid-turn reach the running loop.
 *
 * Handing over: ingress logs and tries the lock in one transaction; a run
 * releases the lock, then checks for work once more, so a message can't fall
 * in the gap.
 *
 * Time: async channels run in /api/worker (ingress starts them there). When a
 * turn can't finish in this function, it ends "paused" or "interrupted"
 * without moving the cursor, and the run hands the chat to a fresh worker,
 * which continues that turn from the log (unfinishedTurn). A turn that keeps
 * getting interrupted is given up after MAX_INTERRUPTIONS. Sync channels can't
 * continue elsewhere: their turns end with a forced last step instead.
 *
 * Per chat (chats/): the profile adds to the system prompt, picks the tools
 * and sets the ambient interval; a turn doesn't start once today's cost quota
 * is used up; and after each turn its usage is added up from the log.
 */
import type { ChannelAdapter } from "../channels/types.js";
import { config } from "../config.js";
import { LAST_STEP_MIN_MS, NEW_STEP_MIN_MS, timeLeftMs } from "../agent/budget.js";
import { runTurn, type TurnResult } from "../agent/loop.js";
import { OutOfCreditError } from "../agent/model.js";
import { SYSTEM_PROMPT } from "../agent/system-prompt.js";
import { ambientInterval, chatProfile, type ChatProfile } from "../chats/profile.js";
import { beijingTime, nextDayStart } from "../chats/day.js";
import { costQuotaUsed, quotaPolicy, recordUsage, turnUsage, usageToday } from "../chats/usage.js";
import type { SessionEvent } from "../conversation/events.js";
import { recoverOpenTurn, unfinishedTurn } from "../conversation/recovery.js";
import { Session } from "../conversation/session.js";
import { getStore, LockLostError, type ChatStore } from "../store/index.js";
import { Toolset } from "../tools/registry.js";
import { makeToolContext } from "./context.js";
import { startWorker } from "./handoff.js";
import { RunLock } from "./lock.js";
import { Outbox } from "./outbox.js";
import { wakeFor, type Trigger } from "./sampler.js";
import type { ChatMeta } from "./types.js";

export type { ChatMeta };

/** Interrupted turns in a row before the run gives up on them (each one already had a whole function). */
const MAX_INTERRUPTIONS = 2;
/** Sync channels: a turn starts only with time for a few steps before its forced last one. */
const SYNC_TURN_MIN_MS = LAST_STEP_MIN_MS + 30_000;
const GIVE_UP_TEXT = "这件事每次做到一半都超时了，我先停在这里。可以把它拆小一点再让我做。";
const ERROR_TEXT = "抱歉，处理消息时出错了，请稍后再试。";

/** What an @ or a DM gets while the model key has no money left; ordinary group messages get nothing. */
export function outOfCreditText(resetsAt?: number): string {
  return resetsAt === undefined ? "没余额了，暂时回不了消息。" : `没余额了，暂时回不了消息（${beijingTime(resetsAt)} 恢复）。`;
}

/** What an @ or a DM gets once the chat's daily cost quota is used up. */
const quotaUsedText = (scene: "群聊" | "私聊") =>
  `${scene === "群聊" ? "这个群" : "这里"}今天的额度用完了，${beijingTime(nextDayStart())} 恢复。`;

/** The persona, the channel's formatting hint, and the chat's own instructions. */
function systemPrompt(adapter: ChannelAdapter, profile: ChatProfile): string {
  return [SYSTEM_PROMPT, adapter.promptHint, profile.prompt ? `# 这个聊天的额外设定\n\n${profile.prompt}` : ""].filter(Boolean).join("\n\n");
}

export interface RunOptions {
  /** Sync channels: replies are collected here instead of sent. */
  collect?: string[];
  /** The sampler window was already claimed for this run (an ambient message woke it). */
  ambientClaimed?: boolean;
  /** When the platform kills this function (epoch ms). Default: maxDuration from now. */
  deadline?: number;
  /** A lock the caller already took for this run (ingress takes it while logging the message). */
  lock?: RunLock;
}

/**
 * How a drain ended: nothing left to do ("idle"); out of time with work for a
 * fresh function ("handoff"); or stopping with work left for a later run
 * ("stopped": a sync channel out of time, or the platform unreachable).
 */
type DrainEnd = { outcome: "idle" | "stopped" } | { outcome: "handoff"; ambientClaimed: boolean };

/**
 * Run the agent for a chat if no one else is: take the lock, handle turns
 * until nothing is pending, release, look once more. Returns false when
 * another run holds the lock.
 */
export async function runChat(adapter: ChannelAdapter, meta: ChatMeta, opts: RunOptions = {}): Promise<boolean> {
  const store = getStore();
  const chatKey = `${meta.channel}:${meta.conversationId}`;
  // Every round of this function shares one deadline: when the platform kills it.
  const deadline = opts.deadline ?? Date.now() + config.agent.maxDurationSeconds * 1000;
  // A run can only hand over if a worker can carry on: an async channel, and somewhere to reach it.
  const continuable = !opts.collect && Boolean(adapter.send) && Boolean(meta.origin);
  let ambientClaimed = opts.ambientClaimed ?? false;

  for (let round = 0; ; round++) {
    let lock: RunLock;
    if (round === 0 && opts.lock) {
      lock = opts.lock;
      lock.hold();
    } else {
      lock = new RunLock(store, chatKey);
      if (!(await lock.acquire())) return round > 0;
    }

    let end: DrainEnd;
    let session: Session | null = null;
    try {
      ({ end, session } = await drain(store, adapter, meta, { collect: opts.collect, ambientClaimed, deadline, continuable, owner: lock.owner }));
    } catch (err) {
      if (!(err instanceof LockLostError)) throw err;
      // The lease ran out and another run took the chat; that run carries on from the log.
      console.warn(`[runner] ${chatKey}: lost the lock, stopping`);
      return true;
    } finally {
      await lock.release();
    }

    if (end.outcome === "handoff") {
      // If the worker can't be reached, the work stays in the log for the next message's run.
      await startWorker(meta.origin!, { chatKey, ambientClaimed: end.ambientClaimed });
      return true;
    }
    if (end.outcome === "stopped" || !session) return true;
    // Something may have arrived after the last check, while its webhook couldn't get the lock.
    // (If another run took over meanwhile, a stale read only costs a lock attempt: that run handles it.)
    await session.refresh();
    const pending = session.messagesAfter(session.cursor);
    if (pending.length && unfinishedTurn(session.events)) {
      ambientClaimed = false;
      continue;
    }
    const trigger = await wakeFor(store, chatKey, pending, false, ambientInterval(await chatProfile(chatKey)));
    if (!trigger) return true;
    ambientClaimed = trigger === "ambient";
  }
}

async function drain(
  store: ChatStore,
  adapter: ChannelAdapter,
  meta: ChatMeta,
  opts: { collect?: string[]; ambientClaimed: boolean; deadline: number; continuable: boolean; owner: string },
): Promise<{ end: DrainEnd; session: Session | null }> {
  const chatKey = `${meta.channel}:${meta.conversationId}`;
  const { deadline, continuable } = opts;
  const session = await Session.open(store, chatKey, opts.owner);
  if (!session) return { end: { outcome: "idle" }, session };

  // A run that was killed left its turn open: close it ("interrupted"), and the turn is continued below.
  const fixes = recoverOpenTurn(session.events);
  if (fixes.length) {
    console.warn(`[runner] ${chatKey}: closing an interrupted turn`);
    await session.append(...fixes);
  }

  const outbox = new Outbox(store, adapter, session, meta, opts.collect);
  const profile = await chatProfile(chatKey);
  const turnState: { main: number; turn?: number } = { main: -1 };
  const { ctx, endRun } = makeToolContext(adapter, meta, chatKey, deadline, outbox, session, turnState, opts.collect);
  let ambientClaimed = opts.ambientClaimed;

  const done = (end: DrainEnd) => ({ end, session });
  try {
    for (let turns = 0; ; turns++) {
      // Session.open just read the log; after a turn, read what arrived during it.
      if (turns > 0) await session.refresh();
      const pending = session.messagesAfter(session.cursor);
      // An unfinished turn is continued whatever the sampler says; its messages already woke the agent.
      const resume = pending.length ? unfinishedTurn(session.events) : undefined;
      const trigger: Trigger | null = resume?.trigger ?? (await wakeFor(store, chatKey, pending, ambientClaimed, ambientInterval(profile)));
      if (!trigger) return done({ outcome: "idle" });
      // The window claim (if any) goes with the work: to this turn, or to the worker taking over.
      const claimed = trigger === "ambient" && !resume;
      ambientClaimed = false;
      if (timeLeftMs(deadline) < (continuable ? NEW_STEP_MIN_MS : SYNC_TURN_MIN_MS)) {
        // Sync channels: what's left waits for the next request.
        return done(continuable ? { outcome: "handoff", ambientClaimed: claimed } : { outcome: "stopped" });
      }

      const direct = trigger === "direct";
      turnState.turn = undefined;
      const today = await usageToday(chatKey);
      if (costQuotaUsed(profile, today)) {
        // Like running out of credit: those who called hear about it once per batch, the rest wait for tomorrow.
        console.warn(`[runner] ${chatKey}: daily cost quota used up (${direct ? "told the chat" : "ambient, skipped"})`);
        if (direct && (await outbox.canReply(pending.at(-1)!.seq))) {
          await ctx.send({ kind: "text", text: quotaUsedText(ctx.chat.scene) }, pending.at(-1)!.seq).catch(() => {});
        }
        await session.setCursor(pending.at(-1)!.seq);
        continue;
      }
      // Replies go by default to the newest @ (else newest) message that can still take one.
      const main =
        (await findLastAsync(pending.filter((m) => m.data.mentioned), (m) => outbox.canReply(m.seq))) ??
        (await findLastAsync(pending, (m) => outbox.canReply(m.seq))) ??
        pending.at(-1)!;
      turnState.main = main.seq;
      ctx.sent = [];
      ctx.chat.sender = main.data.sender;
      const turn = await session.nextTurn();
      turnState.turn = turn;
      const started = Date.now();
      const firstSeq = session.state.nextSeq;
      try {
        const result = await runTurn({
          session,
          ctx,
          systemPrompt: systemPrompt(adapter, profile),
          toolset: new Toolset(quotaPolicy(profile, today)),
          turn,
          trigger,
          pending,
          main,
          canReply: () => outbox.canReply(main.seq),
          unreachable: () => Boolean(outbox.unreachable),
          continuable,
          resume,
        });
        logTurn(chatKey, turn, { direct, pending, result, sent: ctx.sent.length, ms: Date.now() - started, resumes: resume?.turn });

        if (result.reason === "paused" || result.reason === "interrupted") {
          // The cursor stays: a fresh function continues this turn on the same messages.
          if ((unfinishedTurn(session.events)?.interruptions ?? 0) < MAX_INTERRUPTIONS) return done({ outcome: "handoff", ambientClaimed: false });
          console.warn(`[runner] ${chatKey}: turn ${turn} interrupted ${MAX_INTERRUPTIONS} times in a row, giving up`);
          await session.setCursor(result.handledUpTo);
          if (direct) await ctx.send({ kind: "text", text: GIVE_UP_TEXT }).catch(() => {});
        } else {
          if (direct && ctx.sent.length === 0 && result.text) await ctx.send({ kind: "text", text: result.text }).catch(() => {});
          await session.setCursor(result.handledUpTo);
        }
      } catch (err) {
        if (err instanceof LockLostError) throw err;
        await session.setCursor(pending.at(-1)!.seq);
        if (err instanceof OutOfCreditError) {
          // Not a bug: one line, and only those who called the bot hear about it.
          console.warn(`[runner] turn ${turn} for ${chatKey}: model out of credit (${direct ? "told the chat" : "ambient, skipped"}): ${err.message}`);
          if (direct) await ctx.send({ kind: "text", text: outOfCreditText(err.resetsAt) }).catch(() => {});
        } else {
          console.error(`[runner] turn ${turn} failed for ${chatKey}`, err);
          if (direct && ctx.sent.length === 0) await ctx.send({ kind: "text", text: ERROR_TEXT }).catch(() => {});
        }
      } finally {
        // A continued turn already counted as a turn where it started.
        const used = turnUsage(session.events.filter((e) => e.seq >= firstSeq));
        if (resume) delete used.turns;
        await recordUsage(chatKey, used);
      }
      // The platform is down: leave what's left for the next run instead of more turns that can't send.
      if (outbox.unreachable) return done({ outcome: "stopped" });
    }
  } finally {
    await endRun();
  }
}

function logTurn(
  chatKey: string,
  turn: number,
  t: { direct: boolean; pending: SessionEvent<"user/message">[]; result: TurnResult; sent: number; ms: number; resumes?: number },
) {
  const { result } = t;
  console.log(
    `[turn] ${chatKey} #${turn} ${t.direct ? "direct" : "ambient"}${t.resumes !== undefined ? ` resumes=#${t.resumes}` : ""} ` +
      `pending=${t.pending.length} steps=${result.steps} end=${result.reason} sent=${t.sent} input=${result.usage.input} ` +
      `cached=${result.usage.cached} reasoning=${result.usage.reasoning} ms=${t.ms}`,
  );
}

async function findLastAsync<T>(items: T[], ok: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (let i = items.length - 1; i >= 0; i--) if (await ok(items[i]!)) return items[i];
  return undefined;
}
