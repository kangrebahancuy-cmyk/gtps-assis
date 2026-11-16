import { AiError } from "@/server/ai/errors";
import { isProviderId, type ChatMessage, type ChatRequest, type ChatRole, type ProviderId } from "@/types/ai";

/** Hand-written validators for everything that arrives from the browser. */

const invalid = (message: string): AiError => new AiError("invalid_input", message);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validateProvider(value: unknown): ProviderId {
  if (!isProviderId(value)) throw invalid("Unknown provider. Use \"gemini\" or \"groq\".");
  return value;
}

/** Printable ASCII, no spaces, 8-512 characters. Provider-specific prefixes are not enforced because they change. */
export function validateApiKey(value: unknown): string {
  if (typeof value !== "string") throw invalid("The API key must be text.");
  const key = value.trim();
  if (key.length < 8) throw invalid("The API key is too short.");
  if (key.length > 512) throw invalid("The API key is too long.");
  if (!/^[\x21-\x7E]+$/.test(key)) throw invalid("The API key contains spaces or characters that are not allowed.");
  return key;
}

export function validateModelId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw invalid("The model id is not valid.");
  }
  return value;
}

export const MAX_MESSAGES = 100;
export const MAX_MESSAGE_CHARS = 100_000;
export const MAX_TOTAL_CHARS = 400_000;
export const MAX_OUTPUT_TOKENS = 131_072;

const ROLES: readonly ChatRole[] = ["system", "user", "assistant"];

export function validateChatRequest(body: unknown): ChatRequest {
  if (!isObject(body)) throw invalid("The request body must be a JSON object.");

  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid("messages must be a non-empty array.");
  if (body.messages.length > MAX_MESSAGES) throw invalid(`At most ${MAX_MESSAGES} messages are allowed.`);

  let total = 0;
  const messages: ChatMessage[] = body.messages.map((raw, index) => {
    if (!isObject(raw) || !ROLES.includes(raw.role as ChatRole) || typeof raw.content !== "string") {
      throw invalid(`messages[${index}] needs a role (system, user or assistant) and text content.`);
    }
    if (raw.content.trim() === "") throw invalid(`messages[${index}] is empty.`);
    if (raw.content.length > MAX_MESSAGE_CHARS) throw invalid(`messages[${index}] is longer than ${MAX_MESSAGE_CHARS} characters.`);
    total += raw.content.length;
    return { role: raw.role as ChatRole, content: raw.content };
  });
  if (total > MAX_TOTAL_CHARS) throw invalid(`The conversation is longer than ${MAX_TOTAL_CHARS} characters.`);
  if (!messages.some((m) => m.role === "user")) throw invalid("At least one user message is required.");

  const request: ChatRequest = { messages };
  if (body.docs !== undefined) {
    if (typeof body.docs !== "boolean") throw invalid("docs must be true or false.");
    if (body.docs) {
      // The server writes the system prompt itself; the last message must be the user's question.
      request.docs = true;
      request.messages = messages.filter((m) => m.role !== "system");
      if (request.messages[request.messages.length - 1]?.role !== "user") throw invalid("With docs enabled, the last message must be from the user.");
    }
  }
  if (body.mode !== undefined) {
    if (body.mode !== "chat" && body.mode !== "generate") throw invalid('mode must be "chat" or "generate".');
    if (body.mode === "generate") {
      // The generator always searches the documentation and writes its own system prompt.
      request.mode = "generate";
      request.docs = true;
      request.messages = messages.filter((m) => m.role !== "system");
      if (request.messages[request.messages.length - 1]?.role !== "user") throw invalid("In generate mode, the last message must be from the user.");
    }
  }
  if (body.provider !== undefined) request.provider = validateProvider(body.provider);
  if (body.model !== undefined) request.model = validateModelId(body.model);
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
      throw invalid("temperature must be a number between 0 and 2.");
    }
    request.temperature = body.temperature;
  }
  if (body.maxOutputTokens !== undefined) {
    if (!Number.isInteger(body.maxOutputTokens) || (body.maxOutputTokens as number) < 1 || (body.maxOutputTokens as number) > MAX_OUTPUT_TOKENS) {
      throw invalid(`maxOutputTokens must be a whole number between 1 and ${MAX_OUTPUT_TOKENS}.`);
    }
    request.maxOutputTokens = body.maxOutputTokens as number;
  }
  return request;
}
