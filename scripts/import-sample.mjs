// Adds an existing clip to the gallery as the sample for an effect,
// embedding that effect's recipe in it.
// Usage: node scripts/import-sample.mjs <preset-id> <clip.mp4> [author]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [presetId, src, author = "forkfield"] = process.argv.slice(2);
const preset = JSON.parse(fs.readFileSync(path.join(ROOT, "presets/presets.json"), "utf8")).find((p) => p.id === presetId);
if (!preset || !src) throw new Error("Usage: node scripts/import-sample.mjs <preset-id> <clip.mp4> [author]");

const id = crypto.randomUUID().slice(0, 8);
const recipe = {
  forkfield: 1,
  id,
  parent: null,
  author,
  created: new Date().toISOString(),
  effect: {
    preset: preset.id,
    name: preset.name,
    workflow: "forkfield_open.api.json",
    endframe_prompt: preset.endframe_prompt,
    motion_prompt: preset.motion_prompt,
    duration: preset.duration,
    seed: preset.seed,
  },
  models: ["Qwen-Image-Edit 2511 + Lightning LoRA (end frame)", "LTX-2.5 22B distilled (first + last frame to video, with audio)"],
};

const dir = path.join(ROOT, "data/clips");
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `${id}.mp4`);
const payload = "forkfield:" + Buffer.from(JSON.stringify(recipe)).toString("base64");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-map", "0", "-c", "copy", "-movflags", "+use_metadata_tags+faststart", "-metadata", `comment=${payload}`, out]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "4.5", "-i", out, "-frames:v", "1", "-vf", "scale=360:-2", path.join(dir, `${id}.jpg`)]);

const dbFile = path.join(ROOT, "data/clips.json");
const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, "utf8")) : { clips: [] };
db.clips = db.clips.filter((c) => !(c.effect.preset === preset.id && !c.parent && c.author === author));
db.clips.push({ ...recipe, video: `/clips/${id}.mp4`, poster: `/clips/${id}.jpg` });
fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
console.log(`${preset.id} → ${out}`);
