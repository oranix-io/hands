import { describe, expect, it } from "vitest";
import {
  addChangelogLanguage,
  isValidChangelogLanguage,
  parseChangelogMarkdown,
  parseChangelog,
  removeChangelogLanguage,
  serializeChangelog,
  updateChangelogEntry,
} from "./changelogFormat";

describe("changelog editor format", () => {
  it("keeps legacy plain Markdown as plain text", () => {
    const parsed = parseChangelog("## Changes\n- Fixed sync");
    expect(parsed).toEqual({
      localized: false,
      entries: [{ language: "default", markdown: "## Changes\n- Fixed sync" }],
    });
    expect(serializeChangelog(parsed)).toBe("## Changes\n- Fixed sync");
  });

  it("opens localized JSON as language entries instead of raw JSON", () => {
    const parsed = parseChangelog(JSON.stringify({ en: "- Fixed sync", "zh-CN": "- 修复同步" }));
    expect(parsed.localized).toBe(true);
    expect(parsed.entries).toEqual([
      { language: "zh-CN", markdown: "- 修复同步" },
      { language: "en", markdown: "- Fixed sync" },
    ]);
    expect(JSON.parse(serializeChangelog(parsed))).toEqual({
      "zh-CN": "- 修复同步",
      en: "- Fixed sync",
    });
  });

  it("edits, adds and removes languages without changing the storage contract", () => {
    let parsed = parseChangelog("- Initial note");
    parsed = addChangelogLanguage(parsed, "en");
    parsed = addChangelogLanguage(parsed, "zh-CN");
    parsed = updateChangelogEntry(parsed, "zh-CN", "- 初始说明");
    expect(JSON.parse(serializeChangelog(parsed))).toEqual({
      en: "- Initial note",
      "zh-CN": "- 初始说明",
    });

    parsed = removeChangelogLanguage(parsed, "en");
    expect(parsed).toEqual({
      localized: true,
      entries: [{ language: "zh-CN", markdown: "- 初始说明" }],
    });

    parsed = removeChangelogLanguage(parsed, "zh-CN");
    expect(parsed).toEqual({
      localized: true,
      entries: [{ language: "zh-CN", markdown: "- 初始说明" }],
    });
  });

  it("accepts BCP-47-ish language tags and rejects storage-key junk", () => {
    expect(isValidChangelogLanguage("zh-CN")).toBe(true);
    expect(isValidChangelogLanguage("en")).toBe(true);
    expect(isValidChangelogLanguage("pt-BR")).toBe(true);
    expect(isValidChangelogLanguage("default")).toBe(false);
    expect(isValidChangelogLanguage("__proto__")).toBe(false);
  });

  it("does not mistake arrays, scalar JSON or mixed objects for localized notes", () => {
    expect(parseChangelog('["one"]')).toMatchObject({ localized: false });
    expect(parseChangelog('"one"')).toMatchObject({ localized: false });
    expect(parseChangelog('{"en":"one","count":2}')).toMatchObject({ localized: false });
  });

  it("previews the same safe Markdown subset as the public release page", () => {
    expect(parseChangelogMarkdown("- one **bold**\n- two <script>x</script>\n\nplain `c`")).toEqual([
      {
        type: "list",
        items: [
          [
            { type: "text", value: "one " },
            { type: "strong", value: "bold" },
          ],
          [{ type: "text", value: "two <script>x</script>" }],
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", value: "plain " },
          { type: "code", value: "c" },
        ],
      },
    ]);
  });
});
