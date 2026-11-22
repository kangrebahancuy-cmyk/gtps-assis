import { IndexedDbChatRepository } from "@/lib/chat/idb-repository";
import { repositoryContract } from "../../support/chat-repo-contract";
import { conv, msg } from "../../support/chat-fixtures";

const w = window as unknown as Record<string, unknown>;

async function fresh(name: string): Promise<IndexedDbChatRepository> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
  return IndexedDbChatRepository.open(indexedDB, name);
}

/** Runs one shared contract case against a brand-new database. */
w.runCase = async (index: number): Promise<{ ok: boolean; error?: string }> => {
  const repo = await fresh(`contract-${index}`);
  try {
    await repositoryContract[index]!.run(repo);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    repo.close();
  }
};

const DB = "persist-test";
/** Writes data and leaves it in the database (used for reload/restart tests). */
w.writeData = async () => {
  const repo = await IndexedDbChatRepository.open(indexedDB, DB);
  await repo.commit({ conversation: conv("keep", { title: "Survives", messageCount: 2, provider: "gemini", model: "gemini-alpha", updatedAt: 42 }), put: [msg("keep", 0, { content: "héllo 🙂" }), msg("keep", 1)] });
  await repo.setMeta("activeId", "keep");
  repo.close();
};
w.readData = async () => {
  const repo = await IndexedDbChatRepository.open(indexedDB, DB);
  const out = { conversations: await repo.listConversations(), messages: await repo.getMessages("keep"), meta: await repo.getMeta("activeId") };
  repo.close();
  return out;
};
w.wipe = async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
};

/** A commit that fails half way must leave nothing behind. */
w.atomicity = async () => {
  const repo = await fresh("atomic");
  await repo.commit({ conversation: conv("a", { title: "before" }), put: [msg("a", 0)] });
  let threw = false;
  try {
    // The second message has no id: IndexedDB refuses it while the first writes are already queued.
    await repo.commit({ conversation: conv("a", { title: "after" }), put: [msg("a", 1), { ...msg("a", 2), id: undefined as unknown as string }] });
  } catch {
    threw = true;
  }
  const result = { threw, title: (await repo.getConversation("a"))?.title, ids: (await repo.getMessages("a")).map((m) => m.id) };
  repo.close();
  return result;
};

w.unavailable = async () => {
  try {
    await IndexedDbChatRepository.open(null);
    return "opened";
  } catch (e) {
    return (e as Error).message;
  }
};

/** Step 11 performance: a large history. Returns the real timings in milliseconds. */
w.bench = async (conversations: number, perConversation: number): Promise<Record<string, number>> => {
  const repo = await fresh("bench");
  const timings: Record<string, number> = {};
  const time = async <T,>(name: string, f: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    const r = await f();
    timings[name] = Math.round((performance.now() - t) * 10) / 10;
    return r;
  };
  try {
    const exported = Array.from({ length: conversations }, (_, c) => ({
      ...conv(`c${c}`, { updatedAt: 1000 + c, title: `Conversation ${c} about player teleport` }),
      messages: Array.from({ length: perConversation }, (_, m) => msg(`c${c}`, m, { content: `message ${m} of conversation ${c}: ` + "Lua teleport player world ".repeat(20) })),
    }));
    await time("importMs", () => repo.importConversations(exported as never));
    const list = await time("listConversationsMs", () => repo.listConversations());
    const msgs = await time("getMessagesMs", () => repo.getMessages(`c${Math.floor(conversations / 2)}`));
    const hits = await time("searchMs", () => repo.search("teleport", 50));
    await time("appendMessageMs", () => repo.commit({ put: [msg("c0", perConversation + 1)] }));
    await time("deleteConversationMs", () => repo.deleteConversation("c1"));
    await time("snapshotMs", () => repo.snapshot());
    timings.conversations = list.length;
    timings.messagesInChat = msgs.length;
    timings.searchHits = hits.length;
    timings.totalMessages = conversations * perConversation;
    return timings;
  } finally {
    repo.close();
  }
};
