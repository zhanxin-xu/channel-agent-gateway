/**
 * Store contract test: `npm run test:store`.
 * The same cases against MemoryStore and, when TEST_DATABASE_URL points at a
 * Postgres you can throw away, against PostgresStore running the real
 * functions of supabase/schema.sql (it recreates the `gateway` schema there).
 */
import assert from "node:assert/strict";
import { MemoryStore, PostgresStore, type ChatStore, type IngestInput } from "../src/store/index.js";
import { postgresRpc, rpcResponse } from "./rpc-shim.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function msg(chat: string, eventId: string, over: Partial<IngestInput> = {}): IngestInput {
  return {
    chat,
    channel: "qq",
    conversationId: chat.slice(3),
    chatType: "group",
    origin: "https://bot.example.com",
    eventId,
    direct: true,
    event: { type: "user/message", data: { eventId, text: eventId, images: [] } },
    reset: false,
    upgrade: { type: "user/mentioned", data: { eventId } },
    wake: true,
    ambientIntervalSeconds: 10,
    lockOwner: `owner-${eventId}`,
    lockTtlMs: 60_000,
    ...over,
  };
}

async function contract(name: string, store: ChatStore) {
  let failed = 0;
  const test = async (title: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`✓ [${name}] ${title}`);
    } catch (err) {
      failed++;
      console.error(`✗ [${name}] ${title}\n`, err);
    }
  };

  await test("ingest: wake, de-duplicate, busy, @ upgrade, ambient window", async () => {
    const c = "qq:g1";
    assert.deepEqual(await store.ingest(msg(c, "m0")), { status: "acquired", seq: 0 });
    assert.deepEqual(await store.ingest(msg(c, "m0")), { status: "duplicate" });
    assert.deepEqual(await store.ingest(msg(c, "m1")), { status: "busy", seq: 1 }, "lock held by m0's run");
    // An ordinary message: first one in the window wakes (busy: still locked), the next is only recorded.
    assert.deepEqual(await store.ingest(msg(c, "m2", { direct: false })), { status: "busy", seq: 2 });
    assert.deepEqual(await store.ingest(msg(c, "m3", { direct: false })), { status: "recorded", seq: 3 });
    // m3 comes back as an @: logged as a mark, wakes; a further copy is a duplicate.
    assert.deepEqual(await store.ingest(msg(c, "m3")), { status: "busy", seq: 4 });
    assert.deepEqual(await store.ingest(msg(c, "m3")), { status: "duplicate" });
    const { session, events } = await store.open(c, -1);
    assert.deepEqual(
      events.map((e) => [e.seq, e.type]),
      [[0, "user/message"], [1, "user/message"], [2, "user/message"], [3, "user/message"], [4, "user/mentioned"]],
    );
    assert.deepEqual(events[4]!.data, { eventId: "m3" });
    assert.ok(Math.abs(events[0]!.time - Date.now()) < 60_000, "time in epoch ms");
    assert.equal(session!.channel, "qq");
    assert.equal(session!.conversationId, "g1");
    assert.equal(session!.chatType, "group");
    assert.equal(session!.origin, "https://bot.example.com");
    assert.equal(session!.nextSeq, 5);
    assert.equal(session!.minSeq, 0);
    assert.equal(session!.cursor, -1);
    assert.equal(session!.turn, 0);
    assert.equal(session!.formatVersion, 1);
    assert.equal(typeof session!.createdAt, "number");
    // A wake-less event (reset is the real one) is recorded even when it would otherwise wake.
    assert.equal((await store.ingest(msg("qq:g1b", "n0", { wake: false }))).status, "recorded");
  });

  await test("open: unknown chat, and only events after a seq", async () => {
    assert.deepEqual(await store.open("qq:nobody", -1), { session: null, events: [] });
    const { events } = await store.open("qq:g1", 2);
    assert.deepEqual(events.map((e) => e.seq), [3, 4]);
    assert.deepEqual((await store.open("qq:g1", Number.MAX_SAFE_INTEGER)).events, []);
  });

  await test("append: contiguous seqs in order, first seq returned", async () => {
    const c = "qq:g1";
    // m0's run holds the lock (it took it at ingest).
    assert.equal(await store.append(c, "owner-m0", [{ type: "turn/start", data: { turn: 1 } }, { type: "step/start", data: { turn: 1, step: 1 } }]), 5);
    assert.equal(await store.append(c, "owner-m0", [{ type: "step/end", data: { turn: 1, step: 1 } }]), 7);
    const { session, events } = await store.open(c, 4);
    assert.deepEqual(events.map((e) => [e.seq, e.type]), [[5, "turn/start"], [6, "step/start"], [7, "step/end"]]);
    assert.deepEqual(events[1]!.data, { turn: 1, step: 1 });
    assert.equal(session!.nextSeq, 8);
    await assert.rejects(store.append("qq:nobody", "x", [{ type: "turn/start", data: {} }]));
  });

  await test("lock: acquire / renew / release by owner, expiry", async () => {
    const c = "qq:g1";
    assert.equal(await store.lock(c, "other", 60_000, "acquire"), false, "m0's run holds it");
    assert.equal(await store.lock(c, "other", 60_000, "renew"), false);
    assert.equal(await store.lock(c, "other", 60_000, "release"), false);
    assert.equal(await store.lock(c, "owner-m0", 60_000, "renew"), true);
    assert.equal(await store.lock(c, "owner-m0", 60_000, "release"), true);
    assert.equal(await store.lock(c, "other", 50, "acquire"), true);
    await sleep(120);
    assert.equal(await store.lock(c, "third", 60_000, "acquire"), true, "an expired lease is free");
    assert.equal(await store.lock(c, "other", 60_000, "renew"), false, "the old owner lost it");
    assert.equal(await store.lock(c, "third", 60_000, "release"), true);
    assert.equal(await store.lock("qq:nobody", "x", 60_000, "acquire"), false);
  });

  await test("ambient claim, turn counter, cursor", async () => {
    const c = "qq:g2";
    await store.ingest(msg(c, "a0", { wake: false }));
    assert.equal(await store.lock(c, "run", 60_000, "acquire"), true);
    assert.equal(await store.claimAmbient(c, 0), false, "interval 0: never");
    assert.equal(await store.claimAmbient(c, 10), true);
    assert.equal(await store.claimAmbient(c, 10), false);
    assert.equal(await store.beginTurn(c, "run"), 1);
    assert.equal(await store.beginTurn(c, "run"), 2);
    await store.setCursor(c, "run", 0);
    const { session } = await store.open(c, 0);
    assert.equal(session!.turn, 2);
    assert.equal(session!.cursor, 0);
  });

  await test("replies: per message, replaced on put", async () => {
    const c = "qq:g2";
    assert.equal(await store.getReply(c, "a0"), null);
    await store.putReply(c, "a0", { msg_id: "a0", msgSeq: "1", replies: "1" });
    await store.putReply(c, "a0", { msg_id: "a0", msgSeq: "2", replies: "2" });
    assert.deepEqual(await store.getReply(c, "a0"), { msg_id: "a0", msgSeq: "2", replies: "2" });
  });

  await test("trim: drops events before a seq and the images they reference", async () => {
    const c = "qq:g3";
    await store.putImage(c, "img:a", "data:image/jpeg;base64,AAAA");
    await store.putImage(c, "img:b", "data:image/jpeg;base64,BBBB");
    await store.ingest(msg(c, "t0", { event: { type: "user/message", data: { eventId: "t0", images: ["img:a"] } } }));
    await store.append(c, "owner-t0", [{ type: "tool/images", data: { turn: 1, step: 1, images: ["img:b"] } }]);
    await store.append(c, "owner-t0", [{ type: "compaction/summary", data: { fromSeq: 1, summary: "s" } }]);
    assert.deepEqual(await store.getImages(["img:a", "img:b", "img:none"]), {
      "img:a": "data:image/jpeg;base64,AAAA",
      "img:b": "data:image/jpeg;base64,BBBB",
    });
    assert.deepEqual(await store.getImages([]), {});
    await store.trim(c, "owner-t0", 1);
    assert.deepEqual(Object.keys(await store.getImages(["img:a", "img:b"])), ["img:b"]);
    const { session, events } = await store.open(c, -1);
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
    assert.equal(session!.minSeq, 1);
    assert.equal(session!.nextSeq, 3);
  });

  await test("fencing: a run that lost its lock can't write", async () => {
    const c = "qq:g4";
    await store.ingest(msg(c, "f0", { lockTtlMs: 50 }));
    await sleep(120);
    assert.equal(await store.lock(c, "new-run", 60_000, "acquire"), true, "the old lease ran out; another run took it");
    await assert.rejects(store.append(c, "owner-f0", [{ type: "turn/start", data: {} }]), (e: Error) => e.name === "LockLostError");
    await assert.rejects(store.beginTurn(c, "owner-f0"), (e: Error) => e.name === "LockLostError");
    await assert.rejects(store.setCursor(c, "owner-f0", 0), (e: Error) => e.name === "LockLostError");
    await assert.rejects(store.trim(c, "owner-f0", 1), (e: Error) => e.name === "LockLostError");
    assert.equal(await store.append(c, "new-run", [{ type: "turn/start", data: {} }]), 1);
    // Without an upgrade event, a repeat that is now direct is just a duplicate.
    await store.ingest(msg(c, "f1", { direct: false, wake: false }));
    assert.deepEqual(await store.ingest(msg(c, "f1", { upgrade: undefined })), { status: "duplicate" });
  });

  await test("reset: deletes the log, its images and reply state; numbering continues", async () => {
    const c = "qq:g3";
    await store.putReply(c, "t0", { replies: "1" });
    const r = await store.ingest(msg(c, "reset1", { event: { type: "session/reset", data: {} }, reset: true, wake: false }));
    assert.deepEqual(r, { status: "recorded", seq: 3 });
    const { session, events } = await store.open(c, -1);
    assert.deepEqual(events.map((e) => [e.seq, e.type]), [[3, "session/reset"]]);
    assert.equal(session!.minSeq, 3);
    assert.deepEqual(await store.getImages(["img:b"]), {});
    assert.equal(await store.getReply(c, "t0"), null);
  });

  return failed;
}

let failed = await contract("memory", new MemoryStore());

const url = process.env.TEST_DATABASE_URL;
if (url) {
  const { rpc, client } = await postgresRpc(url);
  const answer = rpcResponse(rpc, "sb_secret_test");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (!req.url.startsWith("https://db.test/rest/v1/rpc/")) return realFetch(input, init);
    return answer(req.url, req.headers, await req.json());
  }) as typeof fetch;
  try {
    failed += await contract("postgres", new PostgresStore("https://db.test", "sb_secret_test"));
    const expired = await rpc("gateway_expire", { p_days: 0 });
    assert.ok((expired as { sessions: number }).sessions >= 3, "gateway_expire removes quiet sessions");
    const left = await client.query("select (select count(*) from gateway.events) e, (select count(*) from gateway.replies) r");
    assert.deepEqual(left.rows[0], { e: "0", r: "0" }, "with everything they own");
    console.log("✓ [postgres] gateway_expire");
  } finally {
    globalThis.fetch = realFetch;
    await client.end();
  }
} else {
  console.log("- [postgres] skipped: set TEST_DATABASE_URL to run against a real Postgres");
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all store tests passed");
