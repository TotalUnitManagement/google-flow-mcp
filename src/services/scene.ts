import { promises as fs } from "node:fs";
import * as path from "node:path";
import { config } from "../config.js";
import { KNOWN_PROCEDURES, MIN_MEDIA_BYTES, TIMEOUTS } from "../constants.js";
import { FlowError } from "../types.js";
import { assertNoStopSignal, getFlowPage } from "./browser.js";
import { chooseOriginalSize, openVideoEditor } from "./media.js";
import { clickByText } from "./transport.js";

/**
 * SCENEBUILDER EXPORT
 *
 * Stitching clips in Scenebuilder is free — there is no approval card, because
 * nothing is generated. Only "Extend" costs credits, and this module never
 * touches it.
 *
 * The hard part is retrieval. Flow's export runs a `runVideoFxConcatenation`
 * job and returns the finished MP4 as base64 inside the poll response; Chromium
 * never writes a file. The previous shell-based driver had to monkey-patch
 * window.fetch to intercept it. Playwright can simply read the response body off
 * the wire, which is both simpler and immune to the app changing its fetch usage.
 */

/**
 * Export the open scene editor (flow.google.com: /project/<p>/edit/<id>).
 *
 * The editor's top-bar "Download media" menu offers "270p Animated GIF",
 * "360p Original size" and "720p Upscaled"; this picks "Original size". What
 * arrives is taken from whichever channel carries it, armed before the click:
 *   1. a browser download (Playwright's `download` event) — saved as-is;
 *   2. a flow-content.google/video request — observed for a one-clip scene,
 *      where the export IS the clip; fetched from Node (self-signed url);
 *   3. the legacy base64 concat payload, kept for older deployments.
 * A multi-clip export is not yet observed, which is why all three are armed.
 * Every result must be a real MP4 before anything is written.
 */
export async function exportScene(
  outFile: string,
  timeoutMs = TIMEOUTS.exportMs,
): Promise<{ file: string; bytes: number; via: "download" | "cdn" | "legacy" }> {
  const page = await getFlowPage();
  await assertNoStopSignal(page);

  if (!/\/(edit|scene)\//.test(page.url())) {
    throw new FlowError(
      "The browser is not in a scene editor.",
      "Open one with flow_create_scene (it opens a clip's editor), then retry. Nothing was charged.",
    );
  }

  // Arm every channel BEFORE clicking, or a fast export finishes unobserved.
  const download = page.waitForEvent("download", { timeout: timeoutMs }).catch(() => null);
  let cdnUrl: string | null = null;
  const onRequest = (req: import("playwright-core").Request) => {
    if (!cdnUrl && /flow-content\.google\/video\/[0-9a-f-]{36}/.test(req.url())) cdnUrl = req.url();
  };
  page.on("request", onRequest);
  const legacy = page
    .waitForResponse(
      (res) =>
        new RegExp(`${KNOWN_PROCEDURES.concatenateStatus}|${KNOWN_PROCEDURES.concatenate}`, "i").test(res.url()) &&
        res.status() < 400,
      { timeout: timeoutMs },
    )
    .catch(() => null);

  try {
    await chooseOriginalSize();

    const target = path.isAbsolute(outFile) ? outFile : path.join(config.outputDir, outFile);
    await fs.mkdir(path.dirname(target), { recursive: true });

    let first = await Promise.race([
      download.then((d) => (d ? ({ kind: "download", d } as const) : null)),
      waitFor(() => cdnUrl, timeoutMs).then((u) => (u ? ({ kind: "cdn", u } as const) : null)),
    ]);
    // The editor's player also loads clips from flow-content.google, so a CDN hit
    // may be ONE clip of a multi-clip scene rather than the export. Give a real
    // browser download a grace period to arrive and prefer it when it does.
    if (first?.kind === "cdn") {
      const late = await Promise.race([download, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
      if (late) first = { kind: "download", d: late };
    }

    let buffer: Buffer | null = null;
    let via: "download" | "cdn" | "legacy" = "legacy";
    if (first?.kind === "download") {
      const tmp = await first.d.path().catch(() => null);
      if (tmp) buffer = await fs.readFile(tmp);
      via = "download";
    } else if (first?.kind === "cdn") {
      buffer = Buffer.from(await (await fetch(first.u, { redirect: "follow" })).arrayBuffer());
      via = "cdn";
    } else {
      buffer = Buffer.from(await pollForEncodedVideo(legacy, timeoutMs), "base64");
    }

    if (!buffer || buffer.length < MIN_MEDIA_BYTES || buffer.subarray(4, 8).toString() !== "ftyp") {
      throw new FlowError(
        `Scene export returned ${buffer?.length ?? 0} bytes that are not a valid MP4.`,
        "Nothing was written. The export may still be running — wait and retry, or download the scene in the browser.",
      );
    }
    await fs.writeFile(target, buffer);
    return { file: target, bytes: buffer.length, via };
  } finally {
    page.off("request", onRequest);
  }
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = probe();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * The concat job reports SUCCESSFUL on a later poll than the one that starts it,
 * so we keep reading matching responses until one carries the payload.
 */
async function pollForEncodedVideo(
  first: Promise<import("playwright-core").Response | null>,
  timeoutMs: number,
): Promise<string> {
  const page = await getFlowPage();
  const deadline = Date.now() + timeoutMs;

  let response = await first;
  while (Date.now() < deadline) {
    if (response) {
      const encoded = await extractEncoded(response);
      if (encoded) return encoded;
    }
    response = await page
      .waitForResponse(
        (res) => new RegExp(KNOWN_PROCEDURES.concatenateStatus, "i").test(res.url()) && res.status() < 400,
        { timeout: Math.max(5_000, deadline - Date.now()) },
      )
      .catch(() => null);
    if (!response) break;
  }

  throw new FlowError(
    `Scene export did not return finished video data within ${Math.round(timeoutMs / 1000)}s.`,
    "The stitch itself is free, so nothing was charged. Check the scene in the browser and retry.",
  );
}

async function extractEncoded(response: import("playwright-core").Response): Promise<string | null> {
  try {
    const body = await response.json();
    return findEncodedVideo(body);
  } catch {
    return null;
  }
}

/**
 * SCENE ASSEMBLY (free)
 *
 * flow.google.com has no "create empty scene": the old top-bar "+" -> Create
 * Scene is gone (that menu now holds Upload / New collection / Create
 * character). A scene is a clip's editor — opening any video routes to
 * /project/<p>/edit/<id>, with a timeline, "Add clip" and Download. So a scene
 * is "created" by opening the clip it starts with. Only "Extend" charges, and
 * nothing here touches it.
 */
export async function createScene(firstClipMediaId: string): Promise<{ sceneId: string; url: string }> {
  const page = await getFlowPage();
  await assertNoStopSignal(page);
  const { editId, url } = await openVideoEditor(firstClipMediaId);
  return { sceneId: editId, url };
}

/**
 * Add library clips to the open scene editor, in order. Free.
 *
 * On flow.google.com the editor already holds its first clip, so every clip goes
 * through the timeline "+" popover — by exact "Add clip" label, never arrow keys,
 * because the popover's other item is the charged "Extend". Escape exits the
 * whole editor rather than closing the popover, so it is never used to dismiss.
 * UNVERIFIED on flow.google.com: the clip picker that "Add clip" opens has not
 * been observed; options are matched by media id or by the clip's /asb/ token.
 */
export async function addClipsToScene(mediaIds: string[]): Promise<{ added: string[]; failed: string[] }> {
  const page = await getFlowPage();
  await assertNoStopSignal(page);

  if (!/\/(edit|scene)\//.test(page.url())) {
    throw new FlowError(
      "The browser is not in a scene editor.",
      "Open one with flow_create_scene (it opens the first clip's editor), then add the rest. Nothing was charged.",
    );
  }

  const added: string[] = [];
  const failed: string[] = [];

  for (const mediaId of mediaIds) {
    const opened = /\/edit\//.test(page.url())
      ? await openTimelinePopover()
      : added.length === 0
        ? await clickByText("Add Clip", { exact: false, maxDescendants: 4 })
        : await openTimelinePopover();

    if (!opened) {
      failed.push(mediaId);
      continue;
    }
    await page.waitForTimeout(1_500);

    const picked = await page.evaluate(
      ({ id, token }) => {
        const option = [...document.querySelectorAll<HTMLElement>("[role=option],[role=listitem],li")].find((o) => {
          const img = o.querySelector("img");
          if (!img) return false;
          if (img.src.includes(id) || img.src.includes(encodeURIComponent(id))) return true;
          return token !== null && /\/asb\/([^=?/]+)/.exec(img.src)?.[1] === token;
        });
        if (!option) return false;
        option.click();
        return true;
      },
      { id: mediaId, token: null as string | null },
    );

    if (!picked) {
      failed.push(mediaId);
      continue;
    }

    await clickByText("Add to Scene", { exact: false, maxDescendants: 4 });
    await page.waitForTimeout(1_500);
    added.push(mediaId);
  }

  return { added, failed };
}

/**
 * Open the timeline "+" popover and choose "Add clip" BY EXACT LABEL.
 *
 * On flow.google.com (observed 2026-09-24) the popover holds exactly two items:
 * "Add clip" and "Extend (Veo 3.1 - Lite)" — the charged one. This used to press
 * ArrowDown + Enter blind; if focus started on the first item, that lands on
 * Extend and charges. Now it clicks only an item whose whole label is "Add clip",
 * rejects anything mentioning Extend, and backs out when neither matches.
 */
async function openTimelinePopover(): Promise<boolean> {
  const page = await getFlowPage();
  const opened = await page.evaluate(() => {
    const plus = [...document.querySelectorAll<HTMLElement>("button,[role=button]")]
      .filter((b) => b.getClientRects().length > 0 && !b.closest(".cdk-overlay-container"))
      .find((b) => /^(\+|add clip)$/i.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
    if (!plus) return false;
    plus.click();
    return true;
  });
  if (!opened) return false;

  await page.waitForTimeout(800);
  const picked = await page.evaluate(() => {
    const items = [
      ...document.querySelectorAll<HTMLElement>(
        ".cdk-overlay-pane button, .cdk-overlay-pane [role=menuitem], .cdk-overlay-pane [role=option]",
      ),
    ].filter((e) => e.getClientRects().length > 0);
    const label = (e: HTMLElement) =>
      (e.getAttribute("aria-label") || e.innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^add\s+/i, ""); // icon ligature
    const addClip = items.find((e) => !/extend/i.test(e.innerText) && /^add clip$/i.test(label(e)));
    if (!addClip) {
      document.querySelector<HTMLElement>(".cdk-overlay-backdrop")?.click();
      return false;
    }
    addClip.click();
    return true;
  });
  await page.waitForTimeout(800);
  return picked;
}

/**
 * The payload key nests differently across Flow releases, so search for it.
 * @internal exported for unit tests
 */
export function findEncodedVideo(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findEncodedVideo(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^encodedVideo$|encoded_video/i.test(k) && typeof v === "string" && v.length > 1000) return v;
    const found = findEncodedVideo(v, depth + 1);
    if (found) return found;
  }
  return null;
}
