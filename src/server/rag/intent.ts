import type { IntentKind } from "@/types/rag";

/**
 * Intent detection and keyword extraction for the documentation search.
 * Rule-based on purpose: it is instant, free, works offline, and every decision
 * can be read and tested. It understands English and Indonesian questions.
 */

export interface Intent {
  kind: IntentKind;
  /** Whether the documentation should be searched at all. */
  searchable: boolean;
  /** Code-like names found in the question or in code the user pasted, as written (e.g. "Player:getName"). */
  identifiers: string[];
  /** Lower-case content words for the search, stop words removed, Indonesian glossary applied. */
  terms: string[];
  wants: { api: boolean; example: boolean };
}

const STOP_EN = new Set(
  ("a an and are as at be been but by can could did do does for from get got had has have how i if in into is it its just like make me my of on or our so some than that the their them then there these they this to up us use using was we were what when where which who why will with would you your about also any each more most other please should want need tell show give help take takes taking accept accepts expect expects").split(" "),
);
const STOP_ID = new Set(
  ("yang dan di ke dari untuk pada dengan ini itu atau saya aku kamu anda kita kami mereka ada adalah apa apakah bagaimana gimana kenapa mengapa bisa dapat harus akan sudah belum tidak bukan juga lagi saja aja dong deh nih ya tolong mohon minta buat buatkan bikin bikinkan bantu bantuan mau ingin cara gunakan pakai menggunakan memakai agar supaya sebuah seorang suatu oleh karena jika kalau maka lebih sangat sekali semua setiap beberapa antara dalam tentang seperti yaitu yakni").split(" "),
);

/** Words that say nothing about WHAT is asked: they would match half the documentation. */
const GENERIC = new Set(["gtps", "lua", "script", "scripts", "code", "function", "functions", "method", "methods", "example", "examples", "api", "docs", "documentation", "server"]);

/**
 * Words that name WHICH FIELD of an entry is wanted ("what parameters does X take?"), not the topic.
 * Every API entry has parameters, so searching for the word would pull in unrelated entries.
 */
const FIELD_WORDS = new Set(["parameter", "parameters", "param", "params", "argument", "arguments", "args", "return", "returns", "returned", "signature", "signatures", "syntax", "parameter", "argumen", "kembalian"]);

/** A small Indonesian -> English glossary of scripting words, because the documentation is in English. */
const GLOSSARY: Record<string, string[]> = {
  pemain: ["player"], player: ["player"], dunia: ["world"], pesan: ["message"], kirim: ["send"], mengirim: ["send"],
  perintah: ["command"], nama: ["name"], tambah: ["add"], tambahkan: ["add"], menambah: ["add"], hapus: ["remove", "delete"], menghapus: ["remove", "delete"],
  ubah: ["set", "change"], mengubah: ["set", "change"], ganti: ["change", "replace"], ambil: ["get"], mendapatkan: ["get"], dapatkan: ["get"],
  cek: ["check"], periksa: ["check"], memeriksa: ["check"], beli: ["buy"], jual: ["sell"], toko: ["shop", "store"], hadiah: ["reward", "prize"],
  barang: ["item"], inventaris: ["inventory"], tas: ["inventory"], gembok: ["lock"], kunci: ["lock"], blok: ["tile", "block"], petak: ["tile"],
  waktu: ["time", "timer"], penghitung: ["timer"], kejadian: ["event"], peristiwa: ["event"], balikan: ["callback"], masuk: ["join", "enter"], keluar: ["leave", "exit"],
  teleportasi: ["teleport"], pindah: ["move", "teleport"], tampilkan: ["show", "display"], menampilkan: ["show", "display"], simpan: ["save", "store"], menyimpan: ["save", "store"],
  baca: ["read"], tulis: ["write"], berkas: ["file"], basis: ["database"], panggil: ["call"], memanggil: ["call"], sapa: ["greet"], sambutan: ["greet", "welcome"],
  obrolan: ["chat"], ngobrol: ["chat"], bicara: ["chat", "talk"], parameter: ["parameter"], argumen: ["argument"], kembalian: ["return"], mengembalikan: ["return"],
  contoh: ["example"], kesalahan: ["error"], galat: ["error"], perbaiki: ["fix"], memperbaiki: ["fix"],
};

const SMALLTALK = /^(hi|hello|hey|halo|hai|hallo|selamat (pagi|siang|sore|malam)|terima ?kasih|makasih|thanks?|thank you|ok(e|ay)?|sip|mantap|bagus|good|great|nice|bye|dah|sampai jumpa|siapa (kamu|anda)|who are you|what can you do|apa yang (bisa|dapat) kamu)\b[\s!.?,]*(.{0,30})?$/i;

const WANT_API = /\b(function|method|callback|event|api|parameter|param|argument|signature|return|returns|fungsi|metode|parameter|argumen)\b/i;
const WANT_EXAMPLE = /\b(example|examples|sample|snippet|demo|contoh|how (do|to|can)|bagaimana|gimana|cara)\b/i;
const MODIFY = /\b(modify|change|edit|fix|refactor|update|improve|optimi[sz]e|add to|rewrite|ubah|ganti|perbaiki|tambahkan|edit|perbarui|rapikan)\b/i;

const FENCED = /```[\s\S]*?```/g;

/** camelCase / PascalCase / snake_case words, `Owner:method` and `Owner.method`, and anything in backticks. */
function findIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const inner = (m[1] ?? "").trim().replace(/\(.*$/, "");
    if (/^[A-Za-z_][A-Za-z0-9_]*([:.][A-Za-z_][A-Za-z0-9_]*)*$/.test(inner)) found.add(inner);
  }
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:[:.][A-Za-z_][A-Za-z0-9_]*)+/g)) found.add(m[0]);
  for (const m of text.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b|\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g)) found.add(m[0]);
  return [...found].filter((id) => id.length >= 3 && !/^\d/.test(id)).slice(0, 24);
}

/** Names that are called in pasted code: `obj:method(`, `Name(`, `a.b(`. */
export function callsInCode(code: string): string[] {
  const found = new Set<string>();
  // Functions the script defines itself are not API: they are not looked up.
  const defined = new Set<string>();
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*(?:[:.][A-Za-z_][A-Za-z0-9_]*)*)\s*\(/g)) defined.add(m[1] ?? "");
  for (const m of code.matchAll(/\b(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\b/g)) defined.add(m[1] ?? "");
  for (const m of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:[:.][A-Za-z_][A-Za-z0-9_]*)*)\s*\(/g)) {
    const name = m[1] ?? "";
    if (!LUA_BUILTINS.has(name) && !defined.has(name) && !/^(function|if|while|for|return|and|or|not|elseif|until)$/.test(name)) found.add(name);
  }
  return [...found].slice(0, 30);
}

/** Lua's own functions: they are not GTPS API, so they are not looked up. */
const LUA_BUILTINS = new Set(
  ("print pairs ipairs next type tostring tonumber assert error pcall xpcall select require setmetatable getmetatable rawget rawset rawequal rawlen unpack table.insert table.remove table.concat table.sort table.unpack string.format string.sub string.find string.gsub string.gmatch string.match string.rep string.lower string.upper string.len string.byte string.char math.floor math.ceil math.max math.min math.abs math.random math.sqrt math.huge os.time os.date os.clock load dofile loadstring collectgarbage").split(" "),
);

export function splitWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
}

export function detectIntent(question: string, options: { previousUser?: string } = {}): Intent {
  const text = question.trim();
  const code = [...text.matchAll(FENCED)].map((m) => m[0]).join("\n");
  const prose = text.replace(FENCED, " ");
  const hasCode = code.length > 0;

  const rawIdentifiers = [...new Set([...findIdentifiers(prose), ...(hasCode ? callsInCode(code) : [])])];
  // "Player:getName" already contains "getName": do not look the member up a second time.
  const identifiers = rawIdentifiers
    .filter((id) => !rawIdentifiers.some((other) => other !== id && /[:.]/.test(other) && other.toLowerCase().endsWith(`${":"}${id.toLowerCase()}`) || other !== id && other.toLowerCase().endsWith(`.${id.toLowerCase()}`)))
    .slice(0, 30);
  const wants = { api: WANT_API.test(prose) || identifiers.length > 0, example: WANT_EXAMPLE.test(prose) };

  const words = splitWords(prose);
  const terms: string[] = [];
  const fieldWords: string[] = [];
  const add = (w: string) => {
    if (!terms.includes(w)) terms.push(w);
  };
  for (const word of words) {
    if (/^\d+$/.test(word)) continue;
    if (STOP_EN.has(word) || STOP_ID.has(word) || GENERIC.has(word)) continue;
    if (FIELD_WORDS.has(word)) {
      fieldWords.push(word);
      continue;
    }
    const translated = GLOSSARY[word];
    if (translated) for (const t of translated) add(t);
    else add(word);
  }
  // With nothing else to search for ("parameters?"), the field word itself is all there is.
  if (terms.length === 0 && identifiers.length === 0) for (const w of fieldWords) add(w);
  // Short follow-ups ("and the parameters?") borrow the topic of the previous question.
  if (terms.length + identifiers.length < 2 && options.previousUser) {
    for (const w of detectIntent(options.previousUser).terms.slice(0, 6)) add(w);
  }

  let kind: IntentKind;
  if (!hasCode && identifiers.length === 0 && terms.length === 0 && SMALLTALK.test(text)) kind = "smalltalk";
  else if (!hasCode && identifiers.length === 0 && words.length <= 6 && SMALLTALK.test(text)) kind = "smalltalk";
  else if (hasCode || (MODIFY.test(prose) && /\b(script|code|kode|skrip)\b/i.test(prose))) kind = "modify_script";
  else if (wants.example) kind = identifiers.length > 0 && WANT_API.test(prose) ? "api_lookup" : "code_example";
  else if (wants.api) kind = "api_lookup";
  else if (/\b(how|bagaimana|gimana|cara)\b/i.test(prose)) kind = "how_to";
  else kind = "general";

  const searchable = kind !== "smalltalk" && (terms.length > 0 || identifiers.length > 0);
  return { kind, searchable, identifiers, terms: terms.slice(0, 16), wants };
}
