// b2-merge.mjs  (Node 18/20, ESM)
// Merges cam .ts clips from Backblaze B2 (via S3 API) into a single local .ts file
// - No re-mux: simple MPEG-TS concatenation
// - Time semantics: keys encode *local* time; we use a fixed offset (default IST = 330 min)

import fs from "node:fs";
import path from "node:path";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";

const A_HOUR_MS = 3600e3;

const pad2 = (n) => String(n).padStart(2, "0");
const pad4 = (n) => String(n).padStart(4, "0");

// Convert a UTC epoch ms to "local" (fixed offset) parts, then read UTC getters to avoid host TZ
function toLocalParts(utcMs, offsetMin) {
  const d = new Date(utcMs + offsetMin * 60 * 1000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

function fmtLocalForFilename(utcMs, offsetMin) {
  const p = toLocalParts(utcMs, offsetMin);
  return `${pad4(p.y)}_${pad2(p.m)}_${pad2(p.d)}_${pad2(p.h)}_${pad2(p.mi)}_${pad2(p.s)}`;
}

// Prefixes like cam1/YYYY/MM/DD/HH/ spanning the window (local time by fixed offset)
function hourPrefixes(camera, startUtc, endUtc, offsetMin) {
  const out = new Set();
  // Anchor to the local hour boundary
  // Convert start to local, zero minutes/seconds, then back to UTC-ish by subtracting offset
  const p0 = toLocalParts(startUtc, offsetMin);
  const localHourStartUtc = Date.UTC(p0.y, p0.m - 1, p0.d, p0.h, 0, 0) - offsetMin * 60 * 1000;

  for (let t = localHourStartUtc; t <= endUtc; t += A_HOUR_MS) {
    const { y, m, d, h } = toLocalParts(t, offsetMin);
    out.add(`${camera}/${pad4(y)}/${pad2(m)}/${pad2(d)}/${pad2(h)}/`);
  }
  return [...out];
}

// Parse clip start time (UTC ms) from a key ending with /cam_1_YYYY_MM_DD_HH_MM_SS.ts
function parseClipUtcMsFromKey(key, offsetMin) {
  const m = key.match(/\/cam_(\d)_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})\.ts$/);
  if (!m) return null;
  const y = +m[2], mo = +m[3], d = +m[4], h = +m[5], mi = +m[6], s = +m[7];
  // parts are LOCAL time; convert to UTC by subtracting fixed offset
  return Date.UTC(y, mo - 1, d, h, mi, s) - offsetMin * 60 * 1000;
}

// Ensure "cam1"/"cam2" canonical form (accept 1 or "1" too)
function canonicalizeCamera(cam) {
  if (typeof cam === "number") return `cam${cam}`;
  const m = String(cam).match(/^cam?(\d)$/i);
  if (m) return `cam${m[1]}`;
  throw new Error(`camera must be cam1/cam2 or 1/2; got: ${cam}`);
}

async function listClips({ s3, bucket, camera, startUtc, endUtc, offsetMin }) {
  const prefixes = hourPrefixes(camera, startUtc, endUtc, offsetMin);
  const found = [];

  for (const Prefix of prefixes) {
    let token;
    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix,
        ContinuationToken: token
      }));
      for (const o of resp.Contents ?? []) {
        if (!o.Key.endsWith(".ts")) continue;
        const clipUtc = parseClipUtcMsFromKey(o.Key, offsetMin);
        if (clipUtc == null) continue;
        // Include clips starting a little before window to cover boundary joins (5 min)
        if (clipUtc <= endUtc && clipUtc >= startUtc - 5 * 60 * 1000) {
          found.push({ key: o.Key, utc: clipUtc, size: o.Size ?? 0 });
        }
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
  }

  found.sort((a, b) => a.utc - b.utc);
  return found;
}

/**
 * Merge clips into a single local .ts file.
 *
 * @param {Object} opts
 * @param {"cam1"|"cam2"|1|2} opts.camera - Which camera
 * @param {string|Date|number} opts.start - Start time (ISO string with TZ, or Date, or epoch ms)
 * @param {number} opts.durationSec - Duration in seconds
 * @param {string} [opts.outPath] - Local output path; if omitted we auto-name it
 * @param {string} [opts.bucket="visd-cctv"] - B2 bucket name
 * @param {number} [opts.offsetMin=330] - Local offset minutes (IST=330)
 * @param {string} [opts.profile="b2"] - AWS profile (B2 keys)
 * @param {string} [opts.region="ca-east-006"] - B2 region
 * @param {string} [opts.endpoint="https://s3.ca-east-006.backblazeb2.com"] - B2 S3 endpoint
 * @returns {Promise<{ok:true, outPath:string, parts:number, bytes:number}>}
 */
export async function mergeRange(opts) {
  const {
    camera: camIn,
    start,
    durationSec,
    outPath,
    bucket = "visd-cctv",
    offsetMin = 330,
    profile = "b2",
    region = "ca-east-006",
    endpoint = "https://s3.ca-east-006.backblazeb2.com",
  } = opts || {};

  if (!camIn || !start || !durationSec) {
    throw new Error("camera, start, durationSec are required");
  }
  const camera = canonicalizeCamera(camIn);

  const startUtc =
    start instanceof Date ? start.getTime() :
    typeof start === "number" ? start :
    Date.parse(start);

  if (!Number.isFinite(startUtc)) throw new Error("Invalid start time");
  const endUtc = Math.min(startUtc + Number(durationSec) * 1000, Date.now());

  // S3/B2 client pinned to your B2 profile + endpoint
  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: false,          // Backblaze supports virtual-hosted style
    credentials: fromIni({ profile })
  });

  // Find clips in hour folders
  const clips = await listClips({ s3, bucket, camera, startUtc, endUtc, offsetMin });
  if (!clips.length) throw new Error(`no segments found for ${camera} in window`);

  // Decide local file name if not provided
  const stamp = fmtLocalForFilename(startUtc, offsetMin);
  const outFile = outPath ? path.resolve(outPath, `${camera}_${stamp}_${durationSec}.ts`) : path.resolve(process.cwd(), `${camera}_${stamp}_${durationSec}.ts`);

  // Ensure parent dir exists
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // Open one output stream for append
  const ws = fs.createWriteStream(outFile, { flags: "w" });

  let total = 0, idx = 0;
  for (const c of clips) {
    idx++;
    process.stdout.write(`[merge] ${idx}/${clips.length}  ${c.key}  size=${c.size}\n`);
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: c.key }));
    await new Promise((res, rej) => {
      Body.on("error", rej);
      Body.on("end", res);
      Body.pipe(ws, { end: false });
    });
    total += c.size ?? 0;
  }

  // Close file
  await new Promise((res, rej) => {
    ws.end(() => res());
    ws.on("error", rej);
  });

  process.stdout.write(`[merge] DONE → ${outFile}  parts=${clips.length}  bytes=${total}\n`);
  return { ok: true, outPath: outFile, parts: clips.length, bytes: total };
}

/* ------------------------------------------------------------------------- */
/* Example caller — edit these values when you want to make a recording.     */
/* You can also delete this block and import mergeRange() from elsewhere.    */
/* ------------------------------------------------------------------------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  // Example: 2 hours from 2025-10-12 16:19:45 IST
  // Tip: keep BUCKET structure the same as on the Pi: cam1/YYYY/MM/DD/HH/...
  const main = async () => {
    await mergeRange({
      camera: "cam2",                           // "cam1" | "cam2" | 1 | 2
      start: "2025-10-26T09:00:00+05:30",
      durationSec: 2*60*60,
      outPath: "/Users/vdaga01/Desktop/workspace/personal/visdcam_cloud/downloader/merges", // optional custom path
      bucket: "visd-cctv",
      offsetMin: 330,                           // IST
      profile: "b2",
      region: "ca-east-006",
      endpoint: "https://s3.ca-east-006.backblazeb2.com"
    });
  };

  main().catch(err => {
    console.error("merge failed:", err?.message ?? err);
    process.exit(1);
  });
}
