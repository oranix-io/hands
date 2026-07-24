import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "raft-ui";
import {
  addChangelogLanguage,
  isValidChangelogLanguage,
  parseChangelog,
  parseChangelogMarkdown,
  removeChangelogLanguage,
  serializeChangelog,
  updateChangelogEntry,
  type ChangelogDocument,
  type ChangelogInline,
} from "../lib/changelogFormat";

function MarkdownContent({ markdown }: { markdown: string }) {
  if (!markdown.trim()) {
    return <p className="text-sm text-slate-400">No release notes for this language.</p>;
  }
  const blocks = parseChangelogMarkdown(markdown);
  const renderInline = (content: ChangelogInline[]) =>
    content.map((segment, index) => {
      if (segment.type === "strong") return <strong key={index}>{segment.value}</strong>;
      if (segment.type === "code") {
        return <code key={index} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">{segment.value}</code>;
      }
      return <span key={index}>{segment.value}</span>;
    });
  return (
    <div className="space-y-2 break-words text-sm text-slate-700">
      {blocks.map((block, index) =>
        block.type === "list" ? (
          <ul key={index} className="list-disc space-y-1 pl-5">
            {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}
          </ul>
        ) : (
          <p key={index} className="leading-6">{renderInline(block.content)}</p>
        ),
      )}
    </div>
  );
}

function LanguageTabs({
  document,
  activeLanguage,
  onChange,
}: {
  document: ChangelogDocument;
  activeLanguage: string;
  onChange: (language: string) => void;
}) {
  if (!document.localized) return null;
  return (
    <div className="flex max-w-full gap-1 overflow-x-auto pb-1" aria-label="Release note languages">
      {document.entries.map((entry) => (
        <Button
          key={entry.language}
          type="button"
          size="sm"
          variant={entry.language === activeLanguage ? "default" : "ghost"}
          className="shrink-0 text-xs"
          onClick={() => onChange(entry.language)}
        >
          {entry.language}
        </Button>
      ))}
    </div>
  );
}

export function ChangelogViewer({
  value,
  compact = false,
}: {
  value: string;
  compact?: boolean;
}) {
  const document = useMemo(() => parseChangelog(value), [value]);
  const [activeLanguage, setActiveLanguage] = useState(document.entries[0]?.language ?? "default");
  useEffect(() => {
    if (!document.entries.some((entry) => entry.language === activeLanguage)) {
      setActiveLanguage(document.entries[0]?.language ?? "default");
    }
  }, [activeLanguage, document]);
  const active = document.entries.find((entry) => entry.language === activeLanguage) ?? document.entries[0];

  return (
    <div className="space-y-2">
      <LanguageTabs document={document} activeLanguage={activeLanguage} onChange={setActiveLanguage} />
      <div className={compact ? "max-h-40 overflow-y-auto pr-2" : undefined}>
        <MarkdownContent markdown={active?.markdown ?? ""} />
      </div>
    </div>
  );
}

type MarkdownAction = "bold" | "code" | "bullet";

export function ChangelogEditor({
  value,
  onChange,
  minHeightClass = "min-h-[260px]",
}: {
  value: string;
  onChange: (value: string) => void;
  minHeightClass?: string;
}) {
  const document = useMemo(() => parseChangelog(value), [value]);
  const [activeLanguage, setActiveLanguage] = useState(document.entries[0]?.language ?? "default");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [newLanguage, setNewLanguage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!document.entries.some((entry) => entry.language === activeLanguage)) {
      setActiveLanguage(document.entries[0]?.language ?? "default");
    }
  }, [activeLanguage, document]);

  const active = document.entries.find((entry) => entry.language === activeLanguage) ?? document.entries[0];
  const markdown = active?.markdown ?? "";
  const commit = (next: ChangelogDocument) => onChange(serializeChangelog(next));

  const setMarkdown = (next: string) => {
    commit(updateChangelogEntry(document, active?.language ?? "default", next));
  };

  const applyMarkdown = (action: MarkdownAction) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = markdown.slice(start, end);
    let replacement = selected;
    let selectionStart = start;
    let selectionEnd = end;

    if (action === "bold") {
      replacement = `**${selected || "bold text"}**`;
      selectionStart = start + 2;
      selectionEnd = start + replacement.length - 2;
    } else if (action === "code") {
      replacement = `\`${selected || "code"}\``;
      selectionStart = start + 1;
      selectionEnd = start + replacement.length - 1;
    } else if (action === "bullet") {
      replacement = (selected || "List item")
        .split("\n")
        .map((line) => `- ${line}`)
        .join("\n");
      selectionStart = start + 2;
      selectionEnd = start + replacement.length;
    }

    setMarkdown(`${markdown.slice(0, start)}${replacement}${markdown.slice(end)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionEnd);
    });
  };

  const addLanguage = () => {
    const normalized = newLanguage.trim();
    if (!normalized) return;
    const next = addChangelogLanguage(document, normalized);
    commit(next);
    setActiveLanguage(normalized);
    setNewLanguage("");
  };

  const languageValid = isValidChangelogLanguage(newLanguage);

  const removeLanguage = () => {
    if (!document.localized || !active) return;
    const next = removeChangelogLanguage(document, active.language);
    commit(next);
    setActiveLanguage(next.entries[0]?.language ?? "default");
  };

  return (
    <div className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-2 py-2">
        <LanguageTabs document={document} activeLanguage={activeLanguage} onChange={setActiveLanguage} />
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant={mode === "edit" ? "default" : "ghost"} onClick={() => setMode("edit")}>Edit</Button>
          <Button type="button" size="sm" variant={mode === "preview" ? "default" : "ghost"} onClick={() => setMode("preview")}>Preview</Button>
        </div>
      </div>

      {mode === "edit" ? (
        <>
          <div className="flex flex-wrap gap-1 border-b border-slate-200 px-2 py-1.5">
            <Button type="button" size="sm" variant="ghost" className="text-xs font-bold" onClick={() => applyMarkdown("bold")}>Bold</Button>
            <Button type="button" size="sm" variant="ghost" className="text-xs font-mono" onClick={() => applyMarkdown("code")}>Code</Button>
            <Button type="button" size="sm" variant="ghost" className="text-xs" onClick={() => applyMarkdown("bullet")}>Bullets</Button>
          </div>
          <textarea
            ref={textareaRef}
            className={`block w-full resize-y border-0 bg-white px-3 py-3 font-mono text-sm leading-6 outline-none focus:ring-0 ${minHeightClass}`}
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            placeholder={"- Fixed an issue\n- Improved **reliability**\n- Updated `runtime` behavior"}
            aria-label={activeLanguage === "default" ? "Release notes Markdown" : `Release notes Markdown (${activeLanguage})`}
            spellCheck
          />
        </>
      ) : (
        <div className={`${minHeightClass} overflow-y-auto px-4 py-3`}>
          <MarkdownContent markdown={markdown} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-2 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Input
            className="max-w-44 bg-white text-xs"
            value={newLanguage}
            onChange={(event) => setNewLanguage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addLanguage();
              }
            }}
            placeholder="Language, e.g. zh-CN"
            aria-label="New release note language"
          />
          <Button type="button" size="sm" variant="outline" className="text-xs" disabled={!languageValid} onClick={addLanguage}>
            Add language
          </Button>
          {document.localized && document.entries.length > 1 && (
            <Button type="button" size="sm" variant="ghost" className="text-xs text-red-600" onClick={removeLanguage}>
              Remove {activeLanguage}
            </Button>
          )}
        </div>
        <span className="shrink-0 text-xs text-slate-400">
          {document.localized ? `${document.entries.length} languages` : "single language"} · {Array.from(markdown).length} chars
        </span>
      </div>
      <p className="border-t border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-400">
        Preview uses the public changelog subset: paragraphs, bullets, <strong>**bold**</strong>, and <code>`code`</code>. Raw HTML is shown as text.
      </p>
    </div>
  );
}
