// Syntax highlighting for expanded bodies, following t3code: Shiki through @pierre/diffs' shared
// highlighter (JS regex engine, languages loaded on first use), and react-markdown for messages.
import {
  getSharedHighlighter,
  parsePatchFiles,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { Component, Suspense, use, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { FileChange } from "../core/domain.ts";
import { formatShell, unwrapShell } from "../core/shell.ts";
import { commandSegments, outputLang } from "./codeLang.ts";
import { SHIKI_THEMES, useTheme } from "./theme.tsx";

/** Above this, highlighting costs more than it helps; show plain text. */
const MAX_HIGHLIGHT_CHARS = 150_000;
const MAX_CACHED = 400;

const highlighters = new Map<string, Promise<DiffsHighlighter>>();
const htmlCache = new Map<string, string>();

// Adapted from t3code apps/web/src/lib/syntaxHighlighting.ts: unknown languages fall back to "text".
function highlighterFor(lang: string, theme: string): Promise<DiffsHighlighter> {
  const key = `${theme}|${lang}`;
  const cached = highlighters.get(key);
  if (cached) return cached;
  const promise = getSharedHighlighter({
    themes: [theme],
    langs: [lang as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((error: unknown) => {
    if (lang === "text") {
      highlighters.delete(key);
      throw error;
    }
    return highlighterFor("text", theme);
  });
  highlighters.set(key, promise);
  return promise;
}

function Plain({ text }: { text: string }) {
  return <pre className="code plain">{text}</pre>;
}

function Highlighted({ text, lang }: { text: string; lang: string }) {
  const theme = SHIKI_THEMES[useTheme()].name;
  const key = `${theme}|${lang}|${text}`;
  let html = htmlCache.get(key);
  const highlighter = html === undefined ? use(highlighterFor(lang, theme)) : null;
  if (html === undefined && highlighter) {
    try {
      html = highlighter.codeToHtml(text, { lang, theme });
    } catch {
      html = highlighter.codeToHtml(text, { lang: "text", theme });
    }
    if (htmlCache.size >= MAX_CACHED) htmlCache.delete(htmlCache.keys().next().value!);
    htmlCache.set(key, html);
  }
  // Shiki escapes the source text; the HTML only adds its own spans.
  return <div className="code" dangerouslySetInnerHTML={{ __html: html ?? "" }} />;
}

/** Highlighted code block; plain text while the language loads, and for "text". */
export function Code({ text, lang }: { text: string; lang: string }) {
  if (lang === "text" || text.length > MAX_HIGHLIGHT_CHARS) return <Plain text={text} />;
  return (
    <Suspense fallback={<Plain text={text} />}>
      <Highlighted text={text} lang={lang} />
    </Suspense>
  );
}

/** Shell command with heredoc bodies in their own language (python, ts, sql, …). */
export function CommandBlock({ command }: { command: string }) {
  // The `/bin/zsh -lc "…"` wrapper is noise, and its quotes would hide heredoc terminators.
  const segments = commandSegments(unwrapShell(command)).map((s) =>
    s.lang === "bash" ? { ...s, text: formatShell(s.text) } : s,
  );
  return (
    <div className="code-stack cmd">
      {segments.map((s, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- segments are a fixed split of one command
        <Code key={i} text={i === 0 ? `$ ${s.text}` : s.text} lang={s.lang} />
      ))}
    </div>
  );
}

/** Tool output: JSON pretty-printed, diffs and ANSI colors detected, else the source file's language. */
export function OutputBlock({
  text,
  hint,
  failed,
}: {
  text: string;
  hint?: string | undefined;
  failed?: boolean | undefined;
}) {
  const { lang, text: shown } = outputLang(text, hint);
  return (
    <div className={`code-stack out${failed ? " failed" : ""}`}>
      <Code text={shown} lang={lang} />
    </div>
  );
}

class Fallback extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Plain colored diff; used when a patch doesn't parse (e.g. a clipped oversized hunk). */
export function PlainDiff({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="diff">
      {lines.slice(0, 400).map((l, i) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- diff lines are static and never reorder
          key={i}
          className={
            l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : ""
          }
        >
          {l || " "}
        </div>
      ))}
      {lines.length > 400 && <div className="h">… {lines.length - 400} more lines</div>}
    </pre>
  );
}

/** Language-aware diff for one file (code highlighted by its extension, +/- line backgrounds). */
export function FilePatch({ file }: { file: FileChange & { diff: string } }) {
  const shiki = SHIKI_THEMES[useTheme()];
  const plain = <PlainDiff diff={file.diff} />;
  // Same path as t3code's timeline: parse the patch, render FileDiff, fall back to plain on failure.
  const parsed = useMemo(() => {
    const patch = [
      `--- ${file.isNew ? "/dev/null" : `a/${file.path}`}`,
      `+++ ${file.isDeleted ? "/dev/null" : `b/${file.path}`}`,
      file.diff,
    ].join("\n");
    try {
      return parsePatchFiles(
        patch,
        `toolreader:${file.path}:${patch.length}:${patch.slice(-64)}`,
      )[0]?.files[0];
    } catch {
      return undefined;
    }
  }, [file.path, file.diff, file.isNew, file.isDeleted]);
  if (!parsed) return plain;
  return (
    <Fallback fallback={plain}>
      <FileDiff
        className="file-patch"
        fileDiff={parsed}
        options={{
          theme: shiki.name,
          themeType: shiki.type,
          diffStyle: "unified",
          disableFileHeader: true,
          overflow: "wrap",
          // Claude/Cursor edits only know the edited snippet, so their line numbers would be made up.
          disableLineNumbers: !file.exactLines,
        }}
      />
    </Fallback>
  );
}

type MarkdownComponents = NonNullable<Parameters<typeof ReactMarkdown>[0]["components"]>;

function markdownComponents(highlight: boolean): MarkdownComponents {
  return {
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
      const value = String(children).replace(/\n$/, "");
      if (!lang && !value.includes("\n")) return <code>{children}</code>;
      return highlight ? <Code text={value} lang={lang ?? "text"} /> : <Plain text={value} />;
    },
    // Local file links (`/path/x.ts:12`) mean nothing in the browser: show them as code.
    a: ({ href, children }) =>
      /^https?:\/\//.test(href ?? "") ? (
        <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {children}
        </a>
      ) : (
        <code title={href}>{children}</code>
      ),
    // Session text is untrusted: an image would load by itself (a beacon to whoever wrote the
    // URL), so it stays a link to click, here and in static pages.
    img: ({ src, alt }) => {
      const url = typeof src === "string" ? src : "";
      const label = `🖼 ${alt || url}`;
      return /^https?:\/\//.test(url) ? (
        <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {label}
        </a>
      ) : (
        <code title={url}>{label}</code>
      );
    },
  };
}
const HIGHLIGHTED = markdownComponents(true);
const UNHIGHLIGHTED = markdownComponents(false);
const REMARK_PLUGINS = [remarkGfm];

/**
 * Agent notes and reasoning as markdown. Fenced blocks are highlighted only when `highlight` is set
 * (the message is expanded), so long threads don't highlight hundreds of collapsed messages.
 */
export function Markdown({ text, highlight }: { text: string; highlight: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={highlight ? HIGHLIGHTED : UNHIGHLIGHTED}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
