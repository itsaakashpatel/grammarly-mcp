import type { Stagehand } from "@browserbasehq/stagehand";
import { log } from "../../config";
import {
  GrammarlyExtractSchema,
  type GrammarlySuggestion,
  GrammarlySuggestionsExtractSchema,
} from "./schemas";

export interface GrammarlyTaskOptions {
  maxSteps?: number;
  iteration?: number;
  mode?: string;
}

export interface GrammarlyTaskResult {
  aiDetectionPercent: number | null;
  plagiarismPercent: number | null;
  overallScore?: number | null;
  grammarSuggestionCount: number | null;
  grammarSuggestions: GrammarlySuggestion[];
  /** Passages that Grammarly marks as resembling AI text, in document order. */
  aiFlaggedPassages: string[];
  /** Passages that Grammarly matches to an external source, in document order. */
  plagiarismPassages: string[];
  /** The sources named on the match cards, for example "Unveiling Masking | Northside Training". */
  plagiarismSources: string[];
  notes: string;
}

type StagehandPage = NonNullable<
  ReturnType<Stagehand["context"]["pages"]>[number]
>;

// The document body. The page has a second contenteditable, the document
// title (an H1), so a bare [contenteditable] selector finds the wrong element.
const EDITOR_SELECTOR = '.ql-editor[contenteditable="true"]';

const POLL_MS = 1000;
const EDITOR_WAIT_POLLS = 15;
const WORD_COUNT_POLLS = 30;
const SUGGESTION_POLLS = 20;
const CHECK_POLLS = 90;

/**
 * Sleep utility
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reduces text to a comparable form. The editor can join paragraphs with no
 * space and can use typographic quotes and dashes, so remove all whitespace
 * and map those characters to plain ones.
 */
function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "");
}

/**
 * Counts words in prose. A word must contain a letter or a digit, so stray
 * markup such as "-", "#" or "|" does not count, and words joined by a dash
 * or a slash count separately.
 */
export function countWords(text: string): number {
  return text
    .split(/[\s\u2013\u2014/]+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** Reads the "N words" counter from the page text. */
export function parseWordCount(pageText: string): number | null {
  const match = /(\d[\d,]*)\s+words?\b/i.exec(pageText);
  return match?.[1] ? Number(match[1].replace(/,/g, "")) : null;
}

/** Reads the total from the "Review suggestions" panel header. */
export function parseSuggestionCount(panelText: string): number | null {
  const match = /Review suggestions\s*\n\s*(\d+)\s*\n/i.exec(panelText);
  return match?.[1] ? Number(match[1]) : null;
}

export interface ParsedScores {
  aiDetectionPercent: number | null;
  plagiarismPercent: number | null;
  /** True while Grammarly still shows its progress message. */
  checking: boolean;
  /**
   * True when a score came only from the "No plagiarism or AI text detected"
   * sentence. Grammarly shows that sentence for an empty document too, so
   * it counts only after the check was seen running.
   */
  fromAllClear: boolean;
}

/**
 * Reads the scores from the text of the AI text and plagiarism panel.
 * Only sentences that Grammarly shows count. Anything else stays null.
 */
export function parseScores(panelText: string): ParsedScores {
  const checking = /Checking for plagiarism and AI text/i.test(panelText);
  let ai: number | null = null;
  let plagiarism: number | null = null;

  const aiMatch =
    /(\d{1,3})%\s+of your text has patterns that resemble AI text/i.exec(
      panelText,
    );
  if (aiMatch?.[1]) {
    ai = Number(aiMatch[1]);
  } else if (
    /didn[’']t detect (common )?AI text|no AI text detected/i.test(panelText)
  ) {
    ai = 0;
  }

  const plagiarismMatch =
    /(\d{1,3})%\s+of your text (matches|is similar to|resembles existing|has plagiarism)/i.exec(
      panelText,
    );
  if (plagiarismMatch?.[1]) {
    plagiarism = Number(plagiarismMatch[1]);
  } else if (/didn[’']t detect plagiarism/i.test(panelText)) {
    plagiarism = 0;
  }

  // "No plagiarism or AI text detected" covers both scores. Grammarly shows
  // the same sentence for an empty document, so the caller accepts it only
  // after it saw the check running (see fromAllClear).
  let fromAllClear = false;
  if (/No plagiarism or AI text detected/i.test(panelText)) {
    fromAllClear = ai === null || plagiarism === null;
    ai ??= 0;
    plagiarism ??= 0;
  }

  return {
    aiDetectionPercent: ai,
    plagiarismPercent: plagiarism,
    checking,
    fromAllClear,
  };
}

export interface FlaggedMark {
  /** Grammarly's alert id, shared by every span of one flagged passage. */
  id: string;
  /** "h" for an AI passage, "hu" for a plagiarism match. */
  flag: string;
  text: string;
  /** Index of the editor paragraph that holds the span. */
  paragraph: number;
}

// A flagged span carries a class such as "mark_underline_1000331_24|hu%0".
const MARK_CLASS = /mark_underline_(\d+)_\d+\|(hu?)%\d+/;

/**
 * Groups the marked spans into passages. Spans of one alert join in document
 * order, with a space where the alert crosses a paragraph. An alert whose
 * flag is "hu" is a plagiarism match; "h" is an AI passage.
 */
export function groupFlaggedMarks(marks: FlaggedMark[]): {
  aiFlaggedPassages: string[];
  plagiarismPassages: string[];
} {
  const order: string[] = [];
  const byId = new Map<
    string,
    { flag: string; text: string; paragraph: number }
  >();
  for (const mark of marks) {
    const existing = byId.get(mark.id);
    if (!existing) {
      order.push(mark.id);
      byId.set(mark.id, {
        flag: mark.flag,
        text: mark.text,
        paragraph: mark.paragraph,
      });
      continue;
    }
    const joiner = mark.paragraph === existing.paragraph ? "" : " ";
    existing.text = `${existing.text}${joiner}${mark.text}`;
    existing.paragraph = mark.paragraph;
  }
  const aiFlaggedPassages: string[] = [];
  const plagiarismPassages: string[] = [];
  for (const id of order) {
    const passage = byId.get(id);
    const text = passage?.text.replace(/\s+/g, " ").trim() ?? "";
    if (!passage || text === "") {
      continue;
    }
    (passage.flag === "hu" ? plagiarismPassages : aiFlaggedPassages).push(text);
  }
  return { aiFlaggedPassages, plagiarismPassages };
}

/** Reads the source names from the "This text matches · <source>" cards. */
export function parsePlagiarismSources(panelText: string): string[] {
  const sources: string[] = [];
  for (const match of panelText.matchAll(/This text matches\s*·\s*(.+)/g)) {
    const source = match[1]?.trim();
    if (source && !sources.includes(source)) {
      sources.push(source);
    }
  }
  return sources;
}

/** Reads every flagged span in the editor. */
async function readFlaggedMarks(page: StagehandPage): Promise<FlaggedMark[]> {
  const raw = (await page.evaluate(
    ({ selector, pattern }: { selector: string; pattern: string }) => {
      const editor = document.querySelector(selector);
      if (!editor) {
        return [];
      }
      const markClass = new RegExp(pattern);
      const paragraphs = Array.from(editor.children);
      const marks: {
        id: string;
        flag: string;
        text: string;
        paragraph: number;
      }[] = [];
      for (const span of Array.from(
        editor.querySelectorAll("span.alerts-plagiarism"),
      )) {
        const match = markClass.exec(span.className.toString());
        if (!match?.[1] || !match[2]) {
          continue;
        }
        const block = paragraphs.findIndex((p) => p.contains(span));
        marks.push({
          id: match[1],
          flag: match[2],
          text: (span as HTMLElement).innerText ?? span.textContent ?? "",
          paragraph: block,
        });
      }
      return marks;
    },
    { selector: EDITOR_SELECTOR, pattern: MARK_CLASS.source },
  )) as FlaggedMark[] | null;
  return Array.isArray(raw) ? raw : [];
}

/** Reads the page text, with the document text removed so it cannot be mistaken for a result. */
async function readPanels(
  page: StagehandPage,
): Promise<{ pageText: string; editorText: string; panelText: string }> {
  const raw = (await page.evaluate((selector: string) => {
    const main = document.querySelector("main") as HTMLElement | null;
    const editor = document.querySelector(selector) as HTMLElement | null;
    return {
      pageText: main?.innerText ?? document.body.innerText,
      editorText: editor?.innerText ?? "",
    };
  }, EDITOR_SELECTOR)) as { pageText?: string; editorText?: string } | null;

  const pageText = raw?.pageText ?? "";
  const editorText = raw?.editorText ?? "";
  const panelText = editorText ? pageText.replace(editorText, "") : pageText;
  return { pageText, editorText, panelText };
}

/**
 * Pastes the text into the editor with a paste event, the same path a real
 * paste takes. Setting the DOM directly is invisible to Grammarly's editor.
 */
async function pasteIntoEditor(
  page: StagehandPage,
  text: string,
): Promise<boolean> {
  return Boolean(
    await page.evaluate(
      ({ selector, value }: { selector: string; value: string }) => {
        const editor = document.querySelector(selector) as HTMLElement | null;
        if (!editor) {
          return false;
        }
        editor.focus();
        const data = new DataTransfer();
        data.setData("text/plain", value);
        editor.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
        return true;
      },
      { selector: EDITOR_SELECTOR, value: text },
    ),
  );
}

/**
 * Run Grammarly scoring task using Stagehand's deterministic automation.
 * Uses observe()->act() to navigate, a paste event to enter the text, and
 * reads the results from the panel text.
 */
export async function runStagehandGrammarlyTask(
  stagehand: Stagehand,
  text: string,
  options?: GrammarlyTaskOptions,
): Promise<GrammarlyTaskResult> {
  // Access page via context API (V3)
  const page = stagehand.context.pages()[0];
  if (!page) {
    throw new Error("No page available in Stagehand context");
  }

  log("debug", "Starting Stagehand Grammarly scoring task", {
    textLength: text.length,
    iteration: options?.iteration,
    mode: options?.mode,
  });

  try {
    // Step 1: Navigate to Grammarly if not already there
    const currentUrl = page.url();
    if (!currentUrl.includes("app.grammarly.com")) {
      log("debug", "Navigating to Grammarly");
      await page.goto("https://app.grammarly.com", {
        waitUntil: "networkidle",
      });
      await page.waitForLoadState("domcontentloaded");
    }

    // Step 2: Create a new document using observe -> act pattern
    log("debug", "Looking for new document button");
    const newDocObservation = await stagehand.observe(
      "Find the button or link to create a new document. Look for 'New', 'New document', '+', or similar options in the interface.",
    );

    const newDocElement = newDocObservation?.[0];
    if (newDocElement) {
      await stagehand.act(newDocElement);
    } else {
      await stagehand.act(
        "Click on 'New' or the button to create a new document in the Grammarly interface",
      );
    }
    await page.waitForLoadState("domcontentloaded");

    // Step 3: Wait for an empty editor. A new document starts at 0 words.
    let pasted = false;
    for (let poll = 0; poll < EDITOR_WAIT_POLLS && !pasted; poll += 1) {
      await sleep(POLL_MS);
      const { editorText } = await readPanels(page);
      if (normalize(editorText) === "") {
        pasted = await pasteIntoEditor(page, text);
      }
    }
    if (!pasted) {
      throw new Error("Could not find an empty Grammarly editor to paste into");
    }

    // Step 4: Confirm that Grammarly registered the text. The word count is the
    // proof: an empty or partial document would otherwise pass every check.
    const expectedWords = countWords(text);
    const tolerance = Math.max(3, Math.round(expectedWords * 0.02));
    let registeredWords: number | null = null;
    let editorText = "";
    for (let poll = 0; poll < WORD_COUNT_POLLS; poll += 1) {
      await sleep(POLL_MS);
      const panels = await readPanels(page);
      // panelText has the document removed, so "300 words" in an article cannot match
      registeredWords = parseWordCount(panels.panelText);
      editorText = panels.editorText;
      if (
        registeredWords !== null &&
        Math.abs(registeredWords - expectedWords) <= tolerance
      ) {
        break;
      }
    }
    if (
      registeredWords === null ||
      Math.abs(registeredWords - expectedWords) > tolerance
    ) {
      throw new Error(
        `Grammarly registered ${registeredWords ?? "no"} words, expected about ${expectedWords}; refusing to read scores`,
      );
    }
    if (!normalize(editorText).includes(normalize(text).slice(0, 60))) {
      throw new Error(
        "Grammarly editor does not contain the new text; refusing to read scores",
      );
    }
    log("debug", "Grammarly registered the text", {
      registeredWords,
      expectedWords,
    });

    // Step 5: Read the writing suggestions. A failure here never blocks the scores.
    // The count rises while Grammarly checks, so wait until two reads agree.
    let grammarSuggestionCount: number | null = null;
    let previousCount: number | null = null;
    for (let poll = 0; poll < SUGGESTION_POLLS; poll += 1) {
      const count = parseSuggestionCount((await readPanels(page)).panelText);
      if (count !== null && count === previousCount) {
        grammarSuggestionCount = count;
        break;
      }
      previousCount = count;
      grammarSuggestionCount = count;
      await sleep(POLL_MS * 2);
    }
    let grammarSuggestions: GrammarlySuggestion[] = [];
    try {
      const grammar = await stagehand.extract(
        `Look at the Grammarly suggestions sidebar for the document in the editor.
        1. Suggestion count: the total number of suggestions Grammarly shows, or null if no count is visible.
        2. Suggestions: every suggestion card, in order. For each, give the category label
           (for example Correctness, Clarity, Engagement, Delivery, or the card title such as
           "Punctuation problem"), the flagged words copied exactly,
           the proposed replacement, and the short explanation if one is visible.
        Report only what Grammarly shows. Do not invent suggestions.`,
        GrammarlySuggestionsExtractSchema,
      );
      grammarSuggestionCount ??= grammar.suggestionCount;
      grammarSuggestions = grammar.suggestions ?? [];
    } catch (error) {
      log("warn", "Could not read Grammarly suggestions", { error });
    }

    // Step 6: Open the AI text and plagiarism panel. The check starts by itself.
    log("debug", "Opening the AI text and plagiarism panel");
    const aiDetectObservation = await stagehand.observe(
      "Find the tab or button to check for AI text and plagiarism, labeled 'Check for AI text & plagiarism' or similar.",
    );
    const aiDetectElement = aiDetectObservation?.[0];
    if (aiDetectElement) {
      await stagehand.act(aiDetectElement);
    } else {
      await stagehand.act(
        "Click on the 'Check for AI text & plagiarism' tab in the Grammarly sidebar",
      );
    }

    // Step 7: Wait for the result, then read it from the panel text.
    // A result counts only if it can only come from a real check: either the
    // progress message was seen first, or the result carries a number.
    let scores: ParsedScores = {
      aiDetectionPercent: null,
      plagiarismPercent: null,
      checking: true,
      fromAllClear: false,
    };
    let sawChecking = false;
    let accepted = false;
    for (let poll = 0; poll < CHECK_POLLS && !accepted; poll += 1) {
      await sleep(POLL_MS);
      scores = parseScores((await readPanels(page)).panelText);
      sawChecking ||= scores.checking;
      accepted =
        !scores.checking &&
        scores.aiDetectionPercent !== null &&
        scores.plagiarismPercent !== null &&
        (sawChecking || !scores.fromAllClear);
    }

    let notes: string;
    if (accepted) {
      notes = "Scores read from the Grammarly panel text.";
    } else if (scores.checking) {
      notes = "Grammarly was still checking when the wait ended.";
      scores = { ...scores, aiDetectionPercent: null, plagiarismPercent: null };
    } else if (scores.fromAllClear && !sawChecking) {
      notes =
        "Grammarly showed its all-clear message without running a check, which it also shows for an empty document; scores not accepted.";
      scores = {
        ...scores,
        aiDetectionPercent: null,
        plagiarismPercent: null,
        fromAllClear: false,
      };
    } else {
      notes = "Scores read from the Grammarly panel text.";
    }

    // Step 8: Fall back to the LLM reader only for a score the panel text did
    // not give, for example a result sentence that Grammarly has reworded.
    if (
      !accepted &&
      !scores.checking &&
      !notes.includes("all-clear") &&
      (scores.aiDetectionPercent === null || scores.plagiarismPercent === null)
    ) {
      const extractResult = await stagehand.extract(
        `Look at the Grammarly "Check for AI text & plagiarism" panel and extract:
        1. AI Detection Percentage: the percentage of the text that Grammarly says resembles AI text (0-100).
           Report only a number that Grammarly shows. If no number is visible, set it to null. Never estimate.
        2. Plagiarism Percentage: the percentage of the text that matches existing sources (0-100).
           If Grammarly says it did not detect plagiarism, that is 0.
           If shown as "originality" (e.g., "95% original"), convert to plagiarism (100 - originality).
           Report only a number that Grammarly shows. If no number is visible, set it to null. Never estimate.
        3. Notes: what the panel says, including any warning or unavailable feature.`,
        GrammarlyExtractSchema,
      );
      scores = {
        aiDetectionPercent:
          scores.aiDetectionPercent ?? extractResult.aiDetectionPercent,
        plagiarismPercent:
          scores.plagiarismPercent ?? extractResult.plagiarismPercent,
        checking: false,
        fromAllClear: false,
      };
      notes = `Panel text was incomplete; LLM reader used. ${extractResult.notes}`;
    }

    // Step 9: Read the flagged passages and the match sources. A failure here
    // never blocks the scores.
    let flagged = {
      aiFlaggedPassages: [] as string[],
      plagiarismPassages: [] as string[],
    };
    let plagiarismSources: string[] = [];
    if (accepted || !scores.checking) {
      try {
        flagged = groupFlaggedMarks(await readFlaggedMarks(page));
        plagiarismSources = parsePlagiarismSources(
          (await readPanels(page)).panelText,
        );
      } catch (error) {
        log("warn", "Could not read the flagged passages", { error });
      }
    }

    log("info", "Read Grammarly scores", {
      aiDetectionPercent: scores.aiDetectionPercent,
      plagiarismPercent: scores.plagiarismPercent,
      grammarSuggestionCount,
      registeredWords,
    });

    return {
      aiDetectionPercent: scores.aiDetectionPercent,
      plagiarismPercent: scores.plagiarismPercent,
      grammarSuggestionCount,
      grammarSuggestions,
      aiFlaggedPassages: flagged.aiFlaggedPassages,
      plagiarismPassages: flagged.plagiarismPassages,
      plagiarismSources,
      notes: `${notes} Grammarly counted ${registeredWords} words.`,
    };
  } catch (error) {
    // No partial extraction here: after a failure the page can still show the
    // scores of an earlier document, and a stale score is worse than none.
    // The caller retries the whole task.
    log("error", "Stagehand Grammarly task failed", { error });
    throw error;
  }
}

/**
 * Attempt to clean up a Grammarly document after scoring.
 * This helps keep the Grammarly workspace clean.
 */
export async function cleanupGrammarlyDocument(
  stagehand: Stagehand,
): Promise<void> {
  try {
    // Try to delete or close the current document
    await stagehand.act(
      "Delete the current document or close it without saving to clean up",
    );
    log("debug", "Cleaned up Grammarly document");
  } catch {
    log("debug", "Could not clean up Grammarly document (non-critical)");
  }
}
