import { promises as fs } from "node:fs";
import * as path from "node:path";
import { config } from "../config.js";
import { FILE_SIGNATURES, MIN_MEDIA_BYTES, isFlowUrl } from "../constants.js";
import { FlowError, type MediaItem } from "../types.js";
import { getFlowPage, reloadSession } from "./browser.js";

/**
 * Flow's Download button frequently writes nothing to disk in an automated
 * profile, and Scenebuilder exports never touch the filesystem at all. The
 * reliable path is always: media id -> signed CDN url -> fetch bytes ourselves.
 */

/**
 * Video tiles on flow.google.com carry no media id: only a thumbnail served from
 * /asb/<token>. Opening one routes to /project/<p>/edit/<uuid> (an editor id, not
 * the clip's) and loads the clip from flow-content.google/video/<mediaId>?…, so
 * that request is where the id comes from.
 *
 * STOPGAP KEYING. The /asb/ tokens are re-issued on every grid load, so they
 * cannot identify a tile across the navigation that opening it requires. Tiles
 * are keyed by "<name>#<ordinal counted from the END of the finished video
 * tiles>": new clips appear at the front, so from-the-end ordinals survive them,
 * and the name is re-checked on every open. A deletion shifts ordinals, and two
 * same-named clips rely on ordinal alone — replace this with ids read from the
 * grid's own data RPC.
 */
const videoTiles = new Map<string, { mediaId: string; url: string }>();

interface GridEntry {
  mediaId: string | null;
  key: string | null;
  kind: "image" | "video";
  name: string | null;
  thumbnailUrl: string | null;
}

/**
 * Enumerate the project library from the grid DOM.
 *
 * Images (and legacy video tiles) carry `data-media-id` on the element whose src
 * is the media. Id-less `flow-video-tile`s get a stopgap key (see videoTiles) and
 * are resolved by opening them. Tiles inside overlays (the frame picker) are
 * skipped so a picker never inflates the library. A tile still rendering (an
 * `NN%` label, or no loaded source yet) is left out, so "new media appeared"
 * means "finished".
 */
export async function listMedia(
  limit = 50,
  offset = 0,
): Promise<{ items: MediaItem[]; total: number; unresolved: string[] }> {
  const page = await getFlowPage();
  const entries: GridEntry[] = await page.evaluate(() => {
    const out: {
      mediaId: string | null;
      key: string | null;
      kind: "image" | "video";
      name: string | null;
      thumbnailUrl: string | null;
    }[] = [];
    const seen = new Set<string>();
    const finished = (el: HTMLElement) => {
      if (el.closest(".cdk-overlay-container") || el.querySelector("[data-media-id]")) return false;
      const tile = el.closest("flow-grid-tile-container") as HTMLElement | null;
      if (/\b\d{1,3}%/.test(tile?.innerText ?? el.innerText)) return false; // still rendering
      const img = el.querySelector<HTMLImageElement>("img.thumbnail");
      return !!img && img.complete && img.naturalWidth > 0;
    };
    const videos = [...document.querySelectorAll<HTMLElement>("flow-video-tile")].filter(finished);
    // Combined selectors come back in document order, so grid order is kept.
    for (const el of document.querySelectorAll<HTMLElement>("[data-media-id], flow-video-tile")) {
      if (el.closest(".cdk-overlay-container")) continue;
      const tile = el.closest("flow-grid-tile-container,[role=listitem],li,article") as HTMLElement | null;

      if (el.tagName.toLowerCase() === "flow-video-tile") {
        const i = videos.indexOf(el);
        if (i < 0) continue; // legacy id-bearing, still rendering, or not loaded
        const name = (tile?.getAttribute("aria-label") ?? "").trim();
        const img = el.querySelector<HTMLImageElement>("img.thumbnail")!;
        out.push({
          mediaId: null,
          key: `${name}#${videos.length - 1 - i}`,
          kind: "video",
          name: name || null,
          thumbnailUrl: img.currentSrc || img.src,
        });
        continue;
      }

      const id = el.getAttribute("data-media-id");
      if (!id || seen.has(id)) continue;
      const src =
        el instanceof HTMLVideoElement
          ? el.currentSrc || el.src || el.querySelector("source")?.src || ""
          : el instanceof HTMLImageElement
            ? el.complete && el.naturalWidth > 0
              ? el.currentSrc || el.src
              : ""
            : "";
      if (!src) continue;
      seen.add(id);
      const isVideo = el instanceof HTMLVideoElement || /\/video\//.test(src) || !!tile?.querySelector("video");
      out.push({
        mediaId: id,
        key: null,
        kind: isVideo ? "video" : "image",
        name: el.getAttribute("alt") ?? tile?.getAttribute("aria-label") ?? null,
        thumbnailUrl: src,
      });
    }
    return out;
  });

  const items: MediaItem[] = [];
  const unresolved: string[] = [];
  for (const e of entries.slice(offset, offset + limit)) {
    let mediaId = e.mediaId;
    if (!mediaId && e.key) {
      const key = e.key;
      const hit =
        videoTiles.get(key) ??
        (await openVideoTile(key).catch((err: Error) => {
          unresolved.push(`${key}: ${err.message}`);
          return null;
        }));
      mediaId = hit?.mediaId ?? null;
    }
    if (!mediaId) continue; // could not resolve this tile; leave it out rather than guess
    items.push({ mediaId, kind: e.kind, name: e.name, thumbnailUrl: e.thumbnailUrl });
  }
  return { items, total: entries.length, unresolved };
}

/**
 * Open a video tile by stopgap key, read the clip's id and signed url from the
 * flow-content.google/video request it triggers, then return to the grid. Free:
 * viewing a clip generates nothing. Never touches the editor's controls.
 */
async function openVideoTile(key: string, stay = false): Promise<{ mediaId: string; url: string; editUrl: string }> {
  const page = await getFlowPage();
  const gridUrl = page.url();
  const re = /flow-content\.google\/video\/[0-9a-f-]{36}/;

  // After a return to the grid its thumbnails reload, so wait for the tile.
  let mark: number | null = null;
  for (let i = 0; i < 25 && mark === null; i++) {
    mark = await page.evaluate((k) => {
      // Same filter and keying as listMedia: finished, id-less video tiles, keyed
      // "<name>#<ordinal from the end>".
      const vids = [...document.querySelectorAll<HTMLElement>("flow-video-tile")].filter(
        (v) =>
          !v.closest(".cdk-overlay-container") &&
          !v.querySelector("[data-media-id]") &&
          !/\b\d{1,3}%/.test((v.closest("flow-grid-tile-container") as HTMLElement | null)?.innerText ?? "") &&
          !!v.querySelector<HTMLImageElement>("img.thumbnail")?.complete &&
          !!v.querySelector<HTMLImageElement>("img.thumbnail")?.naturalWidth,
      );
      const el = vids.find((v, i) => {
        const name = (v.closest("flow-grid-tile-container")?.getAttribute("aria-label") ?? "").trim();
        return `${name}#${vids.length - 1 - i}` === k;
      });
      if (!el) return null;
      performance.setResourceTimingBufferSize(5000);
      const at = performance.getEntriesByType("resource").length;
      el.querySelector<HTMLImageElement>("img.thumbnail")?.click();
      return at;
    }, key);
    if (mark === null) await page.waitForTimeout(400);
  }
  if (mark === null) {
    throw new FlowError(`No video tile matches ${key} any more.`, "Open the project's All media view and retry.");
  }

  // The editor does not load the clip on open, nor on Play (it decodes off the
  // main thread; observed 2026-09-24). What reliably fetches it is the editor's
  // own Download media -> "Original size", which for a single clip is the clip
  // file itself: a flow-content.google/video/<id> request and a browser
  // download of that url. Read the url from either and cancel the download.
  await page.waitForURL(/\/edit\//, { timeout: 20_000 }).catch(() => undefined);
  let url: string | null = null;
  const onRequest = (r: import("playwright-core").Request) => {
    if (!url && re.test(r.url())) url = r.url();
  };
  let downloadSeen = false;
  // Handles exactly the one download this lookup triggers, then detaches, so it
  // can never cancel a later, real export.
  const onDownload = (d: import("playwright-core").Download) => {
    page.off("download", onDownload);
    downloadSeen = true;
    if (!url && re.test(d.url())) url = d.url();
    d.cancel().catch(() => undefined);
  };
  page.on("request", onRequest);
  page.on("download", onDownload);
  try {
    await page.waitForTimeout(1_500); // let the editor's toolbar settle
    await chooseOriginalSize();
    const deadline = Date.now() + 20_000;
    while (!url && Date.now() < deadline) await page.waitForTimeout(300);
    // The request can win the race; give its download a moment to arrive and be cancelled.
    for (let i = 0; i < 10 && !downloadSeen; i++) await page.waitForTimeout(300);
  } finally {
    page.off("request", onRequest);
    page.off("download", onDownload);
  }
  void mark;

  const editUrl = page.url();
  if (!stay && page.url() !== gridUrl) {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
    if (page.url() !== gridUrl) await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("flow-grid-tile-container", { timeout: 15_000 }).catch(() => undefined);
  }

  const mediaId = url ? /\/video\/([0-9a-f-]{36})/.exec(url)?.[1] : undefined;
  if (!url || !mediaId) {
    throw new FlowError(
      "Opened the video but never saw its flow-content.google/video request.",
      "Nothing was charged. Flow's player may have changed; see references/ui-playbook.md.",
    );
  }
  videoTiles.set(key, { mediaId, url });
  return { mediaId, url, editUrl };
}

/** Open the editor's top-bar "Download media" menu and pick "Original size". Free. */
export async function chooseOriginalSize(): Promise<void> {
  const page = await getFlowPage();
  const opened = await page.evaluate(() => {
    const trigger = [...document.querySelectorAll<HTMLElement>('button[aria-label="Download media"]')].find(
      (b) => b.getClientRects().length > 0 && !b.closest(".cdk-overlay-container"),
    );
    if (!trigger) return false;
    trigger.click();
    return true;
  });
  if (!opened) {
    throw new FlowError(
      'Could not find the editor\'s "Download media" menu.',
      "Flow's editor may have changed — see references/ui-playbook.md. Nothing was charged.",
    );
  }
  await page.waitForTimeout(800);
  const picked = await page.evaluate(() => {
    const item = [
      ...document.querySelectorAll<HTMLElement>(".cdk-overlay-pane [role=menuitem], .cdk-overlay-pane button"),
    ]
      .filter((e) => e.getClientRects().length > 0)
      .find((e) => /Original size/i.test(e.innerText) && e.getAttribute("aria-disabled") !== "true");
    if (!item) {
      document.querySelector<HTMLElement>(".cdk-overlay-backdrop")?.click();
      return false;
    }
    item.click();
    return true;
  });
  if (!picked) {
    throw new FlowError(
      'The Download menu had no enabled "Original size" option.',
      "Nothing was downloaded or charged. Check the menu in the browser.",
    );
  }
}

/**
 * Open a clip's editor and stay there. On flow.google.com a scene is not created
 * empty: opening a video routes to /project/<p>/edit/<id>, which IS the scene
 * editor for that clip (timeline, "Add clip", Download). Free.
 */
export async function openVideoEditor(mediaId: string): Promise<{ editId: string; url: string }> {
  const start = await getFlowPage();
  if (/\/edit\//.test(start.url())) {
    // Tiles only exist on the grid; leave any open editor first.
    await start.goto(start.url().replace(/\/edit\/.*$/, ""), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await start.waitForSelector("flow-grid-tile-container", { timeout: 15_000 }).catch(() => undefined);
  }
  const keyFor = () => [...videoTiles.entries()].find(([, v]) => v.mediaId === mediaId)?.[0];
  if (!keyFor()) await listMedia(500, 0);
  const key = keyFor();
  if (!key) {
    throw new FlowError(
      `No video tile in this project resolves to ${mediaId}.`,
      "Scenes start from a video clip, not an image. Confirm the id with flow_list_media in the project that holds it.",
    );
  }
  const page = await getFlowPage();
  const { editUrl } = await openVideoTile(key, true);
  const editId = /\/edit\/([0-9a-f-]{36})/.exec(editUrl)?.[1];
  if (!editId || !/\/edit\//.test(page.url())) {
    throw new FlowError("Opened the clip but the editor did not load.", "Check the browser. Nothing was charged.");
  }
  return { editId, url: page.url() };
}

/**
 * Resolve a media id to its signed, time-limited CDN url, read from the tile the
 * grid already rendered. For a video tile the <video> source is preferred over a
 * poster image, so a thumbnail is never saved in place of the clip. Id-less video
 * tiles are re-opened for a fresh url, since the one cached may have expired.
 */
export async function resolveMediaUrl(mediaId: string): Promise<string> {
  const page = await getFlowPage();
  const key = [...videoTiles.entries()].find(([, v]) => v.mediaId === mediaId)?.[0];
  if (key) {
    const fresh = await openVideoTile(key).catch(() => null);
    // A reopen that resolves to another clip means the stopgap key went stale.
    const url = fresh?.mediaId === mediaId ? fresh.url : videoTiles.get(key)?.url;
    if (url) return url;
  }

  const url = await page.evaluate((id) => {
    const els = [...document.querySelectorAll<HTMLElement>(`[data-media-id="${CSS.escape(id)}"]`)].filter(
      (e) => !e.closest(".cdk-overlay-container"),
    );
    const tile = els[0]?.closest("flow-grid-tile-container") as HTMLElement | null;
    const video =
      (els.find((e) => e instanceof HTMLVideoElement) as HTMLVideoElement | undefined) ??
      (tile?.querySelector("video") as HTMLVideoElement | null) ??
      undefined;
    if (video) return video.currentSrc || video.src || video.querySelector("source")?.src || null;
    const img = els.find((e) => e instanceof HTMLImageElement) as HTMLImageElement | undefined;
    return img ? img.currentSrc || img.src : null;
  }, mediaId);

  if (url && /^https?:\/\//.test(url)) return url;

  // An id-less video tile this run has not opened yet: listing opens each one.
  if (!key) {
    await listMedia(500, 0);
    const opened = [...videoTiles.values()].find((v) => v.mediaId === mediaId);
    if (opened) return opened.url;
  }

  throw new FlowError(
    `Could not find a rendered tile with a source url for media ${mediaId}.`,
    "Open the project's All media view (no filters) so the tile is on screen, then retry. Confirm the id with flow_list_media.",
  );
}

/**
 * Download and verify. The verification is not paranoia: an expired session
 * returns a 200-ish JSON error body, and writing that straight to disk produces
 * a 27-byte "video" that only fails much later, in the edit.
 */
export async function downloadMedia(
  mediaId: string,
  outFile: string,
): Promise<{ file: string; bytes: number; kind: string }> {
  const target = path.isAbsolute(outFile) ? outFile : path.join(config.outputDir, outFile);
  await fs.mkdir(path.dirname(target), { recursive: true });

  let buffer = await fetchSigned(mediaId);

  // A stale session yields a JSON/text body where media bytes belong. One reload fixes it.
  if (!identify(buffer)) {
    await reloadSession();
    buffer = await fetchSigned(mediaId);
  }

  const kind = identify(buffer);
  if (!kind) {
    const preview = buffer.subarray(0, 200).toString("utf8").replace(/\s+/g, " ");
    throw new FlowError(
      `Downloaded ${buffer.length} bytes for ${mediaId} that are not image or video data. Body starts: ${preview}`,
      `This is the expired-session signature ("No session found"). Nothing was written. Run flow_check_session, then retry.`,
    );
  }
  if (buffer.length < MIN_MEDIA_BYTES) {
    throw new FlowError(
      `Downloaded file for ${mediaId} is only ${buffer.length} bytes — too small to be a real ${kind}.`,
      `Nothing was written. Confirm the generation actually finished before downloading.`,
    );
  }

  await fs.writeFile(target, buffer);
  return { file: target, bytes: buffer.length, kind };
}

/** Fetch bytes inside the signed-in Flow page (same-origin, with the session's cookies). */
async function fetchInPage(url: string): Promise<Buffer> {
  const page = await getFlowPage();
  const b64 = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    if (!r.ok) return "";
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, url);
  return Buffer.from(b64, "base64");
}

/**
 * Tiles on flow.google.com point at /asb/<token>=s1600-rw: a resized proxy that
 * needs the browser session (from Node it redirects to a sign-in page with a
 * 200). So Flow-origin urls are fetched inside the page, asking for the original
 * size ("=s0") first. flow-content.google urls are self-signed and fetched from Node.
 */
async function fetchSigned(mediaId: string): Promise<Buffer> {
  const url = await resolveMediaUrl(mediaId);
  if (isFlowUrl(url)) {
    const original = url.replace(/=[^=/]*$/, "=s0");
    if (original !== url) {
      const full = await fetchInPage(original).catch(() => Buffer.alloc(0));
      if (identify(full)) return full;
    }
    return fetchInPage(url);
  }
  const res = await fetch(url, { redirect: "follow" });
  const buf = Buffer.from(await res.arrayBuffer());
  return identify(buf) ? buf : fetchInPage(url);
}

/**
 * Magic-byte identification. This is the check that stops an expired-session JSON
 * error body from being written to disk as a .jpg.
 * @internal exported for unit tests
 */
export function identify(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  return FILE_SIGNATURES.find((s) => s.test(buffer))?.ext ?? null;
}

/**
 * Deletion hygiene keeps a project navigable, but it is genuinely destructive and
 * has over-reached before — a deleted source clip cannot be re-added to a scene
 * reliably. Callers must pass explicit ids; there is deliberately no "delete all".
 */
export async function deleteMedia(mediaIds: string[]): Promise<{ deleted: string[]; failed: string[] }> {
  const page = await getFlowPage();
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const id of mediaIds) {
    const ok = await page.evaluate((mediaId) => {
      const el = document.querySelector<HTMLElement>(`[data-media-id="${CSS.escape(mediaId)}"]`);
      const card = el?.closest("flow-grid-tile-container,[role=listitem],li,article") as HTMLElement | null;
      if (!card) return false;
      const menu = [...card.querySelectorAll<HTMLElement>("button,[role=button]")].find((b) =>
        /more|option|menu|⋮/i.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
      );
      if (!menu) return false;
      menu.click();
      return true;
    }, id);

    if (!ok) {
      failed.push(id);
      continue;
    }
    await page.waitForTimeout(600);
    const confirmed = await page.evaluate(() => {
      const item = [...document.querySelectorAll<HTMLElement>("[role=menuitem],button,div[role]")].find(
        (e) => e.offsetParent && /^delete|remove$/i.test((e.textContent ?? "").trim()),
      );
      if (!item) return false;
      item.click();
      return true;
    });
    (confirmed ? deleted : failed).push(id);
    await page.waitForTimeout(600);
  }

  return { deleted, failed };
}
