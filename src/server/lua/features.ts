import { extractScript } from "@/lib/lua/extract";

/**
 * Request analysis for the script generator: which kind of script is asked for, which documentation
 * topics must be searched for it, and whether an existing script is being modified.
 * Rule-based on purpose (like intent.ts): instant, offline, testable. It understands English and Indonesian.
 */

export interface Feature {
  key: string;
  label: string;
  /** Words that identify the feature in a request. */
  pattern: RegExp;
  /** Documentation searches that this kind of script needs (each is a separate retrieval). */
  topics: { label: string; query: string }[];
}

export const FEATURES: Feature[] = [
  {
    key: "custom_command",
    label: "Custom player command",
    pattern: /\b(commands?|perintah|chat command|slash|\/[a-z]{2,})\b/i,
    topics: [
      { label: "Command callbacks", query: "command slash callback" },
      { label: "Chat callback / reading player messages", query: "chat callback message player" },
      { label: "Sending messages to a player", query: "send message to player console" },
    ],
  },
  {
    key: "daily_reward",
    label: "Daily reward system",
    pattern: /\b(daily|harian|login bonus|login reward|hadiah harian|every day|tiap hari|setiap hari|claim)\b/i,
    topics: [
      { label: "Giving items to a player", query: "player inventory add item" },
      { label: "Server time (for cooldowns)", query: "current server time" },
      { label: "Saving data between sessions", query: "save data storage database" },
      { label: "Sending messages to a player", query: "send message to player console" },
    ],
  },
  {
    key: "npc_shop",
    label: "NPC shop",
    pattern: /\b(npc|shop|toko|store|vendor|merchant|penjual|buy|sell|beli|jual)\b/i,
    topics: [
      { label: "Shop: buying and selling items", query: "shop buy sell item" },
      { label: "Inventory and items", query: "player inventory item add remove" },
      { label: "Dialogs and menus", query: "dialog menu show player" },
      { label: "Currency / balance", query: "gems balance player" },
    ],
  },
  {
    key: "auto_event",
    label: "Automatic event",
    pattern: /\b(auto(matic(ally)?)?|otomatis|event|schedule[d]?|jadwal|periodic|berkala|every \d+|tiap \d+|broadcast|announce(ment)?|pengumuman)\b/i,
    topics: [
      { label: "Timers and intervals", query: "timer interval repeat" },
      { label: "Broadcasting to players / worlds", query: "broadcast message all players world" },
      { label: "Server events and callbacks", query: "callback event server" },
    ],
  },
  {
    key: "moderation",
    label: "Player moderation system",
    pattern: /\b(moderat\w*|ban|kick|mute|warn(ing)?|admin|report|filter|blacklist|anti[- ]?spam|spam|punish\w*|hukum\w*)\b/i,
    topics: [
      { label: "Player moderation actions", query: "player ban kick mute" },
      { label: "Chat callback / blocking messages", query: "chat callback message block" },
      { label: "Player roles and permissions", query: "player role permission admin" },
      { label: "Sending messages to a player", query: "send message to player console" },
    ],
  },
  {
    key: "mailbox",
    label: "Mailbox reward system",
    pattern: /\b(mail|mailbox|inbox|surat|kotak (surat|masuk)|post ?box|message box)\b/i,
    topics: [
      { label: "Mailbox / mail", query: "mailbox mail send" },
      { label: "Giving items to a player", query: "player inventory add item" },
      { label: "Saving data between sessions", query: "save data storage database" },
    ],
  },
  {
    key: "item_interaction",
    label: "Custom item interaction",
    pattern: /\b(item (interaction|use|effect)|use (an? )?item|consum\w*|activate|punch|wrench|interaksi item|pakai item|gunakan item|tile|block|blok)\b/i,
    topics: [
      { label: "Item use / activation callbacks", query: "item activate use callback" },
      { label: "Tiles and world", query: "world tile get set" },
      { label: "Inventory and items", query: "player inventory item add remove" },
    ],
  },
];

/** Searched for every request, so that events/callbacks and registration are always checked. */
const ALWAYS_TOPIC = { label: "Callback and event registration", query: "callback event register function" };

const MODIFY = /\b(modify|change|edit|fix|refactor|update|improve|optimi[sz]e|rewrite|add (a |an |the )?(comments?|feature|cooldown|check)|explain|ubah|ganti|perbaiki|tambahkan|perbarui|rapikan|optimalkan|jelaskan|modifikasi)\b/i;

/** Verbs that start a NEW script, even when an earlier reply in the conversation had one. */
const NEW_SCRIPT = /\b(create|write|make|build|generate|buat|buatkan|bikin|bikinkan|tulis|tulislah)\b/i;

export interface Analysis {
  features: Feature[];
  /** Existing script being modified (from the request, or the previous reply), or null for a new script. */
  original: string | null;
  /** Retrieval queries, in the order they are searched. */
  topics: { label: string; query: string }[];
  /** The request text without the pasted code (what the person actually asked for). */
  request: string;
}

export function analyzeRequest(messages: ReadonlyArray<{ role: string; content: string }>): Analysis {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const pasted = extractScript(lastUser);
  const request = pasted ? `${lastUser.slice(0, pasted.start)}${lastUser.slice(pasted.end)}`.trim() : lastUser.trim();

  // Modification: code pasted with the request, or a follow-up ("add a cooldown") to the script of the previous reply.
  let original: string | null = pasted?.code ?? null;
  const followUp = MODIFY.test(request) || (!NEW_SCRIPT.test(request) && !request.trimEnd().endsWith("?"));
  if (original === null && followUp) {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
    original = extractScript(lastAssistant)?.code ?? null;
  }

  // Features come from the new request only; for follow-ups, the earlier request still defines what the script is for.
  const searchText = request.length < 60 && original !== null ? `${previousRequest(messages)} ${request}` : request;
  const features = FEATURES.filter((f) => f.pattern.test(searchText));

  const topics: Analysis["topics"] = [];
  const seen = new Set<string>();
  const addTopic = (t: { label: string; query: string }) => {
    if (seen.has(t.query)) return;
    seen.add(t.query);
    topics.push(t);
  };
  // The request itself first: it is the most specific query there is.
  if (request.length > 0) addTopic({ label: "The request itself", query: request.slice(0, 400) });
  for (const f of features) for (const t of f.topics) addTopic(t);
  if (original !== null) addTopic({ label: "APIs used by the existing script", query: `\`\`\`lua\n${original.slice(0, 6000)}\n\`\`\`` });
  addTopic(ALWAYS_TOPIC);
  return { features, original, topics: topics.slice(0, 9), request };
}

function previousRequest(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const users = messages.filter((m) => m.role === "user");
  return users.length >= 2 ? (users[users.length - 2]?.content ?? "").slice(0, 400) : "";
}
