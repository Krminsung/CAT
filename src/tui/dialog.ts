import {
  CURSOR_MARKER, Text, matchesKey, truncateToWidth,
  type Component, type Focusable, type SelectItem,
} from "@earendil-works/pi-tui";
import { fitLine } from "./presentation.js";

interface TerminalSize { readonly columns: number; readonly rows: number; }

function dimensions(size: TerminalSize): { width: number; height: number; contentRows: number } {
  const width = Math.max(1, Math.min(96, size.columns - (size.columns >= 48 ? 8 : 0)));
  const height = Math.max(1, size.rows - (size.rows >= 16 ? 4 : 0));
  return { width, height, contentRows: Math.max(1, height - 2) };
}

/** Full-width padded rows hide the transcript, including on monochrome terminals. */
export class FullscreenDialog implements Component, Focusable {
  constructor(readonly content: Component, readonly size: () => TerminalSize) {}
  get focused(): boolean { return "focused" in this.content && this.content.focused === true; }
  set focused(value: boolean) { if ("focused" in this.content) this.content.focused = value; }
  handleInput(data: string): void { this.content.handleInput?.(data); }
  invalidate(): void { this.content.invalidate(); }
  render(width: number): string[] {
    const size = this.size();
    const rows = Math.max(1, Math.min(1_000, size.rows));
    const box = dimensions({ columns: width, rows });
    const innerWidth = Math.max(1, box.width - 4);
    let content = this.content.render(innerWidth);
    if (content.length > box.contentRows) {
      // Keep the active input and its footer visible when explanatory text is long.
      const cursor = content.findIndex((line) => line.includes(CURSOR_MARKER));
      const end = cursor >= 0 ? Math.min(content.length, cursor + 2) : content.length;
      content = content.slice(Math.max(0, end - box.contentRows + 1), end);
      content.unshift(truncateToWidth("… 설명 일부 생략", innerWidth, ""));
    }
    const padding = " ".repeat(Math.max(0, Math.floor((width - box.width) / 2)));
    const body = box.width >= 6 && rows >= 4
      ? [
          `╭${"─".repeat(box.width - 2)}╮`,
          ...content.map((line) => `│ ${fitLine(line, innerWidth)} │`),
          `╰${"─".repeat(box.width - 2)}╯`,
        ]
      : content;
    const top = Math.max(0, Math.floor((rows - body.length) / 2));
    return Array.from({ length: rows }, (_, index) =>
      fitLine(index >= top && index < top + body.length ? padding + (body[index - top] ?? "") : "", width)
    );
  }
}

export class SelectionPanel implements Component {
  readonly #message: Text;
  #selected = 0;
  #offset = 0;
  #pageRows = 1;
  #bodyRows = 0;
  onSelect: ((item: SelectItem) => void) | undefined;
  onCancel: (() => void) | undefined;
  onSelectionChange: ((item: SelectItem) => void) | undefined;
  onChange: (() => void) | undefined;

  constructor(readonly options: {
    readonly title: string;
    readonly message?: string;
    readonly items: SelectItem[];
    readonly size: () => TerminalSize;
  }) {
    this.#message = new Text(options.message ?? "", 0, 0);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onCancel?.();
      return;
    }
    const size = this.options.size();
    if (size.columns < 24 || dimensions(size).contentRows < 8) return;
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.#selected = (this.#selected + this.options.items.length - 1) % this.options.items.length;
    } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.#selected = (this.#selected + 1) % this.options.items.length;
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      const direction = matchesKey(data, "pageUp") ? -1 : 1;
      this.#offset = Math.max(0, Math.min(this.#bodyRows - this.#pageRows, this.#offset + direction * this.#pageRows));
      this.onChange?.();
      return;
    } else if (matchesKey(data, "enter")) {
      const item = this.options.items[this.#selected];
      if (item) this.onSelect?.(item);
      return;
    } else return;
    const item = this.options.items[this.#selected];
    if (item) this.onSelectionChange?.(item);
    this.onChange?.();
  }

  render(width: number): string[] {
    const size = this.options.size();
    const height = dimensions(size).contentRows;
    if (size.columns < 24 || height < 8) {
      return ["창 크기를 늘려 주세요", "24열 × 10행 이상", "Esc 취소"].slice(0, height);
    }
    const count = Math.min(this.options.items.length, 6, Math.max(1, Math.floor(height / 3)));
    const selected = this.options.items[this.#selected];
    const description = selected?.description ? new Text(selected.description, 0, 0).render(width) : [];
    const descriptionRows = height >= 12 ? Math.min(2, description.length) : 0;
    this.#pageRows = Math.max(1, height - 5 - count - descriptionRows);
    const body = this.#message.render(width);
    this.#bodyRows = body.length;
    this.#offset = Math.max(0, Math.min(this.#offset, body.length - this.#pageRows));
    const start = Math.max(0, Math.min(this.#selected - Math.floor(count / 2), this.options.items.length - count));
    const choices = this.options.items.slice(start, start + count).map((item, index) =>
      `${start + index === this.#selected ? "›" : " "} ${item.label ?? item.value}`
    );
    const range = body.length > this.#pageRows
      ? `본문 ${this.#offset + 1}–${Math.min(body.length, this.#offset + this.#pageRows)}/${body.length} · PgUp/PgDn`
      : "";
    const detail = description.slice(0, descriptionRows);
    if (description.length > descriptionRows && descriptionRows > 0) {
      detail[descriptionRows - 1] = truncateToWidth(`${detail[descriptionRows - 1] ?? ""} …`, width, "…");
    }
    return [
      `/\\_/\\  ${this.options.title}`,
      "─".repeat(width),
      ...body.slice(this.#offset, this.#offset + this.#pageRows),
      range,
      "─".repeat(width),
      ...choices,
      ...detail,
      `↑↓ 선택 · Enter 확인 · Esc 취소 · ${this.#selected + 1}/${this.options.items.length}`,
    ].map((line) => fitLine(line, width));
  }
  invalidate(): void { this.#message.invalidate(); }
  dispose(): void {
    this.onSelect = undefined;
    this.onCancel = undefined;
    this.onSelectionChange = undefined;
    this.onChange = undefined;
  }
}
