import * as vscode from "vscode";

export type TagEditMode = "set" | "add" | "remove";

export interface TagEditorCopy {
  editTagsBtn: string;
  addTagsBtn: string;
  removeTagsBtn: string;
  tagsHelp: string;
  tagsPlaceholder: string;
  tagsRequiredError: string;
  tagsTooManyError: string;
  tagsTooLongError: string;
}

type PromptTagsOptions = {
  copy: TagEditorCopy;
  mode: TagEditMode;
  initialTags?: string[];
  label?: string;
};

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 24;

export async function promptForTags(options: PromptTagsOptions): Promise<string[] | undefined> {
  const { copy, mode, initialTags = [], label } = options;
  const titleBase =
    mode === "add" ? copy.addTagsBtn : mode === "remove" ? copy.removeTagsBtn : copy.editTagsBtn;
  const raw = await vscode.window.showInputBox({
    title: label ? `${titleBase} · ${label}` : titleBase,
    prompt: copy.tagsHelp,
    placeHolder: copy.tagsPlaceholder,
    value: mode === "set" ? initialTags.join(", ") : "",
    ignoreFocusOut: true,
    validateInput: (value) => validateTagInput(value, mode, copy)
  });

  if (raw == null) {
    return undefined;
  }

  return normalizeTagInput(raw);
}

export function normalizeTagInput(raw: string): string[] {
  return Array.from(
    new Map(
      raw
        .split(/[,\n]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 20)
        .map((tag) => [tag.toLowerCase(), tag.slice(0, MAX_TAG_LENGTH)])
    ).values()
  ).slice(0, MAX_TAGS);
}

function validateTagInput(value: string, mode: TagEditMode, copy: TagEditorCopy): string | undefined {
  const parsed = value
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (mode !== "set" && parsed.length === 0) {
    return copy.tagsRequiredError;
  }

  const overLength = parsed.find((tag) => tag.length > MAX_TAG_LENGTH);
  if (overLength) {
    return copy.tagsTooLongError.replace("{value}", String(MAX_TAG_LENGTH));
  }

  const uniqueCount = new Map(parsed.map((tag) => [tag.toLowerCase(), tag])).size;
  if (uniqueCount > MAX_TAGS) {
    return copy.tagsTooManyError.replace("{value}", String(MAX_TAGS));
  }

  return undefined;
}
