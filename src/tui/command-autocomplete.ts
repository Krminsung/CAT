import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { SlashCommandCompletion } from "../commands/registry.js";

export interface SlashCompletionSource {
  completions(prefix?: string): readonly SlashCommandCompletion[];
}

export class SlashCommandAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["/"];

  constructor(readonly source: SlashCompletionSource) {}

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    if (options.signal.aborted || cursorLine < 0 || cursorLine >= lines.length) return null;
    const line = lines[cursorLine] ?? "";
    const before = line.slice(0, cursorCol);
    const match = before.match(/^\/([A-Za-z0-9:_-]*)$/u);
    if (!match) return null;
    const prefix = match[0];
    const completions = this.source.completions(match[1] ?? "");
    if (completions.length === 0) return null;
    const items: AutocompleteItem[] = completions.map((completion) => ({
      value: `/${completion.name}${completion.argumentHint ? " " : ""}`,
      label: `/${completion.name}`,
      description: completion.argumentHint
        ? `${completion.description} · ${completion.argumentHint}`
        : completion.description,
    }));
    return { items, prefix };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const next = [...lines];
    const line = next[cursorLine] ?? "";
    const start = Math.max(0, cursorCol - prefix.length);
    next[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
    return {
      lines: next,
      cursorLine,
      cursorCol: start + item.value.length,
    };
  }
}
