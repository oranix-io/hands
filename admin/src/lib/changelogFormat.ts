export type ChangelogEntry = {
  language: string;
  markdown: string;
};

export type ChangelogDocument = {
  localized: boolean;
  entries: ChangelogEntry[];
};

export type ChangelogInline =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "code"; value: string };

export type ChangelogBlock =
  | { type: "paragraph"; content: ChangelogInline[] }
  | { type: "list"; items: ChangelogInline[][] };

const LANGUAGE_PRIORITY = ["zh-CN", "zh", "en", "en-US", "zh-TW", "ja", "ko"];
const LANGUAGE_CODE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

export function isValidChangelogLanguage(language: string): boolean {
  const normalized = language.trim();
  return normalized !== "default" && LANGUAGE_CODE.test(normalized);
}

function orderLanguages(a: string, b: string): number {
  const ai = LANGUAGE_PRIORITY.indexOf(a);
  const bi = LANGUAGE_PRIORITY.indexOf(b);
  if (ai !== -1 || bi !== -1) {
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  return a.localeCompare(b);
}

export function parseChangelog(value: string | null | undefined): ChangelogDocument {
  const raw = value ?? "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length > 0 &&
      Object.values(parsed).every((entry) => typeof entry === "string")
    ) {
      return {
        localized: true,
        entries: Object.entries(parsed as Record<string, string>)
          .sort(([a], [b]) => orderLanguages(a, b))
          .map(([language, markdown]) => ({ language, markdown })),
      };
    }
  } catch {
    // Plain Markdown is the legacy and single-language representation.
  }

  return {
    localized: false,
    entries: [{ language: "default", markdown: raw }],
  };
}

export function serializeChangelog(document: ChangelogDocument): string {
  if (!document.localized) return document.entries[0]?.markdown ?? "";
  return JSON.stringify(
    Object.fromEntries(document.entries.map(({ language, markdown }) => [language, markdown])),
  );
}

export function updateChangelogEntry(
  document: ChangelogDocument,
  language: string,
  markdown: string,
): ChangelogDocument {
  return {
    ...document,
    entries: document.entries.map((entry) =>
      entry.language === language ? { ...entry, markdown } : entry,
    ),
  };
}

export function addChangelogLanguage(
  document: ChangelogDocument,
  language: string,
): ChangelogDocument {
  const normalized = language.trim();
  if (
    !isValidChangelogLanguage(normalized) ||
    document.entries.some((entry) => entry.language === normalized)
  ) {
    return document;
  }
  if (!document.localized) {
    return {
      localized: true,
      entries: [{ language: normalized, markdown: document.entries[0]?.markdown ?? "" }],
    };
  }
  return {
    localized: true,
    entries: [...document.entries, { language: normalized, markdown: "" }],
  };
}

export function removeChangelogLanguage(
  document: ChangelogDocument,
  language: string,
): ChangelogDocument {
  if (!document.localized || document.entries.length <= 1) return document;
  const entries = document.entries.filter((entry) => entry.language !== language);
  return { localized: true, entries };
}

export function parseChangelogMarkdown(markdown: string): ChangelogBlock[] {
  const inline = (value: string): ChangelogInline[] => {
    const segments: ChangelogInline[] = [];
    const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
    let cursor = 0;
    for (const match of value.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) segments.push({ type: "text", value: value.slice(cursor, index) });
      if (match[1] !== undefined) segments.push({ type: "strong", value: match[1] });
      else segments.push({ type: "code", value: match[2] ?? "" });
      cursor = index + match[0].length;
    }
    if (cursor < value.length) segments.push({ type: "text", value: value.slice(cursor) });
    return segments;
  };

  const blocks: ChangelogBlock[] = [];
  let list: ChangelogInline[][] = [];
  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ type: "list", items: list });
      list = [];
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      list.push(inline(trimmed.slice(2)));
    } else if (!trimmed) {
      flushList();
    } else {
      flushList();
      blocks.push({ type: "paragraph", content: inline(trimmed) });
    }
  }
  flushList();
  return blocks;
}
