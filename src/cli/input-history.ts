/**
 * In-memory command/message history for the interactive CLI prompt.
 *
 * Models the standard shell-style ↑/↓ recall, with one behaviour the operator
 * cares about: an in-progress *draft* (text typed but not yet submitted) is
 * preserved. Pressing ↑ from the draft saves it; pressing ↓ back past the
 * newest entry restores it verbatim, so an accidental ↑ never loses work.
 *
 * The cursor index ranges over [0, entries.length]. `entries.length` is the
 * "live draft" position (i.e. not browsing history). Editing a recalled entry
 * and then navigating away discards the edit (standard readline behaviour) —
 * only the live draft is protected.
 */
export class InputHistory {
  private entries: string[] = [];
  /** Position in history; `entries.length` means "on the live draft". */
  private index = 0;
  /** Live draft saved when the operator first steps up into history. */
  private draft = "";

  constructor(initial: string[] = []) {
    this.entries = initial.filter((line) => line.length > 0);
    this.index = this.entries.length;
  }

  /** Snapshot of recorded entries, oldest → newest. */
  list(): string[] {
    return [...this.entries];
  }

  /**
   * Record a submitted line. Empty lines and lines identical to the most recent
   * entry are ignored so ↑ doesn't surface dead/duplicate rows. Resets the
   * navigation cursor back to the live-draft position.
   */
  push(line: string): void {
    if (line.length > 0 && this.entries[this.entries.length - 1] !== line) {
      this.entries.push(line);
    }
    this.resetCursor();
  }

  /**
   * Reset navigation to the live-draft position and clear the saved draft.
   * Call at the start of each fresh prompt so a cancelled (Ctrl+C) prompt that
   * left the cursor mid-history doesn't leak into the next one.
   */
  resetCursor(): void {
    this.index = this.entries.length;
    this.draft = "";
  }

  /**
   * Move to the previous (older) entry. `current` is the value shown in the
   * editor right now; when stepping off the live draft it is saved so ↓ can
   * restore it. Returns the value to display, or null if already at the oldest
   * entry / there is no history.
   */
  up(current: string): string | null {
    if (this.index <= 0) return null;
    if (this.index === this.entries.length) {
      this.draft = current;
    }
    this.index -= 1;
    return this.entries[this.index] ?? null;
  }

  /**
   * Move to the next (newer) entry. Stepping past the newest entry returns the
   * saved live draft. Returns the value to display, or null if already on the
   * live draft.
   */
  down(): string | null {
    if (this.index >= this.entries.length) return null;
    this.index += 1;
    if (this.index === this.entries.length) return this.draft;
    return this.entries[this.index] ?? null;
  }
}
