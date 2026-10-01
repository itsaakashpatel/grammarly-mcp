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
const CHECK_POLLS = 150;

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

/** Counts words the way Grammarly does for plain prose: runs of non-space. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
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

  // "No plagiarism or AI text detected" covers both scores. It is only safe
  // because the caller confirms the word count before it opens the panel:
  // Grammarly shows the same sentence for an empty document.
  if (/No plagiarism or AI text detected/i.test(panelText)) {
    ai ??= 0;
    plagiarism ??= 0;
  }

  return { aiDetectionPercent: ai, plagiarismPercent: plagiarism, checking };
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
    let grammarSuggestionCount: number | null = null;
    for (let poll = 0; poll < SUGGESTION_POLLS; poll += 1) {
      grammarSuggestionCount = parseSuggestionCount(
        (await readPanels(page)).panelText,
      );
      if (grammarSuggestionCount !== null) {
        break;
      }
      await sleep(POLL_MS);
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
    let scores: ParsedScores = {
      aiDetectionPercent: null,
      plagiarismPercent: null,
      checking: true,
    };
    let panelText = "";
    for (let poll = 0; poll < CHECK_POLLS; poll += 1) {
      await sleep(POLL_MS);
      panelText = (await readPanels(page)).panelText;
      scores = parseScores(panelText);
      if (
        !scores.checking &&
        scores.aiDetectionPercent !== null &&
        scores.plagiarismPercent !== null
      ) {
        break;
      }
    }

    let notes = scores.checking
      ? "Grammarly was still checking when the wait ended."
      : "Scores read from the Grammarly panel text.";

    // Step 8: Fall back to the LLM reader only for a score the panel text did
    // not give, for example a result sentence that Grammarly has reworded.
    if (
      !scores.checking &&
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
      };
      notes = `Panel text was incomplete; LLM reader used. ${extractResult.notes}`;
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
