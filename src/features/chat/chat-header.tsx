import { PLACEHOLDER_MODELS, PLACEHOLDER_PROVIDERS } from "@/lib/constants";

interface ChatHeaderProps {
  title: string;
}

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60";

export function ChatHeader({ title }: ChatHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5 sm:px-6">
      <h1 className="truncate text-sm font-medium">{title}</h1>
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="provider-select">
          Provider
        </label>
        <select id="provider-select" disabled className={SELECT_CLASS}>
          {PLACEHOLDER_PROVIDERS.map((provider) => (
            <option key={provider}>{provider}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="model-select">
          Model
        </label>
        <select id="model-select" disabled className={SELECT_CLASS}>
          {PLACEHOLDER_MODELS.map((model) => (
            <option key={model}>{model}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
