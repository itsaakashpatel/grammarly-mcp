/**
 * One-time Grammarly login into a persistent Browserbase context.
 *
 * Run from the repository root, so src/config.ts finds .env:
 *   pnpm login:grammarly
 *
 * 1. Creates a context, or reuses BROWSERBASE_CONTEXT_ID.
 * 2. Opens app.grammarly.com in a session that persists that context.
 * 3. Prints the live view URL. Log in to Grammarly there, by hand.
 * 4. Waits until the browser is on app.grammarly.com outside the sign-in pages,
 *    then releases the session, which saves the cookies into the context.
 * 5. Writes BROWSERBASE_CONTEXT_ID to .env if it is not there yet.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Browserbase from "@browserbasehq/sdk";
import { type AISdkClient, Stagehand } from "@browserbasehq/stagehand";
import { config } from "../src/config";
import { createStagehandLlmClient } from "../src/llm/stagehandLlm";

const LOGIN_TIMEOUT_SECONDS = 15 * 60;
const POLL_MS = 5000;
const SETTLE_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isLoggedInUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    return (
      hostname === "app.grammarly.com" &&
      !/(signin|login|signup|auth)/i.test(pathname)
    );
  } catch {
    return false;
  }
}

function saveContextId(contextId: string): void {
  const envPath = path.resolve(process.cwd(), ".env");
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  if (/^BROWSERBASE_CONTEXT_ID=\S/m.test(current)) {
    console.log("BROWSERBASE_CONTEXT_ID is already in .env; it was not changed.");
    return;
  }
  // Replace an empty BROWSERBASE_CONTEXT_ID= line, or append a new one.
  const line = `BROWSERBASE_CONTEXT_ID=${contextId}`;
  if (/^BROWSERBASE_CONTEXT_ID=\s*$/m.test(current)) {
    fs.writeFileSync(envPath, current.replace(/^BROWSERBASE_CONTEXT_ID=\s*$/m, line));
  } else {
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.appendFileSync(envPath, `${separator}${line}\n`);
  }
  console.log("Wrote BROWSERBASE_CONTEXT_ID to .env.");
}

async function main(): Promise<void> {
  const { browserbaseApiKey: apiKey, browserbaseProjectId: projectId } = config;
  if (!apiKey || !projectId) {
    throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are required");
  }

  const bb = new Browserbase({ apiKey });
  const contextId =
    config.browserbaseContextId || (await bb.contexts.create({ projectId })).id;
  console.log(`CONTEXT_ID ${contextId}`);

  const session = await bb.sessions.create({
    projectId,
    timeout: LOGIN_TIMEOUT_SECONDS,
    browserSettings: {
      context: { id: contextId, persist: true },
      advancedStealth: config.browserbaseAdvancedStealth,
      solveCaptchas: config.browserbaseSolveCaptchas,
    },
  });

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await bb.sessions.update(session.id, { status: "REQUEST_RELEASE", projectId });
    } catch {
      // The session may already have ended.
    }
  };

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey,
    projectId,
    browserbaseSessionID: session.id,
    llmClient: (await createStagehandLlmClient(config)) as AISdkClient,
    verbose: 0,
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0];
    if (!page) throw new Error("No page in the Browserbase session");

    await page.goto("https://app.grammarly.com", { waitUntil: "domcontentloaded" });

    const debug = await bb.sessions.debug(session.id);
    console.log(`LIVE_URL ${debug.debuggerFullscreenUrl ?? debug.debuggerUrl}`);
    console.log(
      `Log in to Grammarly in the live view. Waiting up to ${LOGIN_TIMEOUT_SECONDS / 60} minutes.`,
    );

    const deadline = Date.now() + (LOGIN_TIMEOUT_SECONDS - 60) * 1000;
    while (Date.now() < deadline) {
      if (isLoggedInUrl(page.url())) {
        console.log("Login detected. Letting cookies settle.");
        await sleep(SETTLE_MS);
        if (isLoggedInUrl(page.url())) {
          await stagehand.close();
          await release();
          saveContextId(contextId);
          console.log("LOGIN_SAVED");
          return;
        }
      }
      await sleep(POLL_MS);
    }
    throw new Error("Timed out waiting for the Grammarly login");
  } finally {
    try {
      await stagehand.close();
    } catch {
      // Already closed.
    }
    await release();
  }
}

main().catch((error: unknown) => {
  console.error("LOGIN_FAILED", error instanceof Error ? error.message : error);
  process.exit(1);
});
