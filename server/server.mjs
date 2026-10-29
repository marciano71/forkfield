// Forkfield server: talks to ComfyUI (local or Comfy Cloud), embeds the recipe
// inside every MP4 and reads it back so any clip can be forked.
// Zero dependencies: Node 20+ and ffmpeg/ffprobe on PATH.

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 8190);
const COMFY_URL = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
const COMFY_API_KEY = process.env.COMFY_API_KEY || "";
const IS_CLOUD = COMFY_URL.includes("comfy.org");
// "open" = open-weights models (Qwen-Image-Edit + LTX-2.5) on your GPU or Comfy Cloud.
// "partner" = FLUX 3 + LTX-2.5 partner nodes, for a ComfyUI without a big GPU.
const ENGINE = process.env.FORKFIELD_ENGINE || "open";
const ENGINE_WORKFLOW = { open: "forkfield_open.api.json", partner: "forkfield_flf2v.api.json" }[ENGINE] || "forkfield_open.api.json";
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 0); // 0 = no limit
const DATA = path.join(ROOT, "data");
const CLIPS_DIR = path.join(DATA, "clips");
const DB_FILE = path.join(DATA, "clips.json");
const RECIPE_PREFIX = "forkfield:";

fs.mkdirSync(CLIPS_DIR, { recursive: true });
const presets = JSON.parse(fs.readFileSync(path.join(ROOT, "presets/presets.json"), "utf8"));
const jobs = new Map();
const SAMPLES_DIR = path.join(ROOT, "samples", "clips");
const SAMPLES_DB = path.join(ROOT, "samples", "clips.json");
// First run: start the gallery with the sample clips that ship in the repo.
let db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
  : fs.existsSync(SAMPLES_DB) ? JSON.parse(fs.readFileSync(SAMPLES_DB, "utf8")) : { clips: [] };

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

async function saveDb() {
  await fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- recipes ----------

// A recipe is everything needed to recreate a clip, minus the person's photo.
function makeRecipe({ preset, overrides = {}, parent = null, author = "anonymous" }) {
  const base = preset || {};
  const recipe = {
    forkfield: 1,
    id: crypto.randomUUID().slice(0, 8),
    parent,
    author: String(author).slice(0, 40),
    created: new Date().toISOString(),
    effect: {
      preset: base.id || overrides.preset || "custom",
      name: (overrides.name || base.name || "Custom effect").slice(0, 60),
      workflow: ENGINE_WORKFLOW,
      endframe_prompt: (overrides.endframe_prompt || base.endframe_prompt || "").slice(0, 2000),
      motion_prompt: (overrides.motion_prompt || base.motion_prompt || "").slice(0, 2000),
      duration: clampDuration(overrides.duration ?? base.duration ?? 5),
      seed: Number.isInteger(overrides.seed) ? overrides.seed : base.seed ?? 7,
      ...(overrides.source === "read-from-video" ? { source: "read-from-video" } : {}),
    },
    models: ENGINE === "partner"
      ? ["FLUX 3 Image (end frame)", "LTX-2.5 Fast API (first + last frame to video)"]
      : ["Qwen-Image-Edit 2511 + Lightning LoRA (end frame)", "LTX-2.5 22B distilled (first + last frame to video, with audio)"],
  };
  if (!recipe.effect.endframe_prompt || !recipe.effect.motion_prompt) throw new Error("Recipe needs both prompts");
  return recipe;
}

function clampDuration(d) {
  const allowed = [2, 3, 4, 5, 6, 8, 10];
  const n = Number(d);
  return allowed.includes(n) ? n : 5;
}

function fillWorkflow(template, values) {
  // Replace "{{KEY}}" string values; numeric placeholders become numbers.
  const walk = (v) => {
    if (typeof v === "string") {
      const whole = v.match(/^\{\{([A-Z_]+)\}\}$/);
      if (whole) return values[whole[1]];
      return v.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => String(values[k] ?? ""));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(template);
}

async function embedRecipe(src, dst, recipe) {
  const payload = RECIPE_PREFIX + Buffer.from(JSON.stringify(recipe)).toString("base64");
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", src,
    "-map", "0", "-c", "copy",
    "-movflags", "+use_metadata_tags+faststart",
    "-metadata", `comment=${payload}`,
    "-metadata", `description=Forkfield clip ${recipe.id}. Drop this file into Forkfield to fork it, or into ComfyUI to open its workflow.`,
    dst,
  ]);
}

async function readRecipe(file) {
  const { stdout } = await run("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", file]);
  const tags = JSON.parse(stdout).format?.tags || {};
  for (const value of Object.values(tags)) {
    if (typeof value === "string" && value.startsWith(RECIPE_PREFIX)) {
      return JSON.parse(Buffer.from(value.slice(RECIPE_PREFIX.length), "base64").toString("utf8"));
    }
  }
  return null;
}

// ---------- ComfyUI ----------

function comfyHeaders(extra = {}) {
  // Comfy Cloud accepts the key as X-API-Key; local ComfyUI ignores it.
  return IS_CLOUD && COMFY_API_KEY ? { "X-API-Key": COMFY_API_KEY, ...extra } : extra;
}

async function comfyUpload(buffer, filename) {
  const form = new FormData();
  form.append("image", new Blob([buffer]), filename);
  form.append("overwrite", "true");
  const res = await fetch(`${COMFY_URL}/api/upload/image`, { method: "POST", body: form, headers: comfyHeaders() });
  if (!res.ok) throw new Error(`ComfyUI upload failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

async function comfyQueue(workflow) {
  const body = { prompt: workflow, client_id: "forkfield" };
  // Partner nodes (FLUX 3, LTX-2.5 API) bill the Comfy account behind this key.
  if (COMFY_API_KEY) body.extra_data = { api_key_comfy_org: COMFY_API_KEY };
  const res = await fetch(`${COMFY_URL}/api/prompt`, {
    method: "POST",
    headers: comfyHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ComfyUI rejected the workflow: ${res.status} ${text.slice(0, 600)}`);
  return JSON.parse(text).prompt_id;
}

async function comfyHistory(promptId) {
  if (IS_CLOUD) {
    // Comfy Cloud: /api/jobs/{id} returns status + outputs in one call.
    const res = await fetch(`${COMFY_URL}/api/jobs/${promptId}`, { headers: comfyHeaders() });
    if (!res.ok) return null;
    const j = await res.json();
    const failed = ["failed", "cancelled", "error"].includes(j.status);
    return {
      outputs: j.status === "completed" ? j.outputs || {} : {},
      status: {
        completed: j.status === "completed",
        status_str: failed ? "error" : j.status,
        messages: failed ? [["execution_error", { exception_message: j.execution_error?.exception_message || `Job ${j.status}` }]] : [],
      },
    };
  }
  const res = await fetch(`${COMFY_URL}/api/history/${promptId}`, { headers: comfyHeaders() });
  if (!res.ok) return null;
  return (await res.json())[promptId] || null;
}

async function comfyDownload(file) {
  const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
  const res = await fetch(`${COMFY_URL}/api/view?${q}`, { headers: comfyHeaders() });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- jobs ----------

function todayCount() {
  const day = new Date().toISOString().slice(0, 10);
  return db.clips.filter((c) => c.created.startsWith(day)).length + [...jobs.values()].filter((j) => j.state === "running").length;
}

async function startJob({ photo, presetId, overrides, parent, author }) {
  if (DAILY_LIMIT && todayCount() >= DAILY_LIMIT) throw Object.assign(new Error("Daily limit reached. Run Forkfield locally to keep forking."), { status: 429 });
  const preset = presets.find((p) => p.id === presetId);
  if (!preset && !overrides?.endframe_prompt) throw new Error("Unknown effect");
  const recipe = makeRecipe({ preset, overrides, parent, author });

  const m = String(photo || "").match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m) throw new Error("Photo must be a PNG, JPG or WEBP");
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > 15 * 1024 * 1024) throw new Error("Photo is too large (15 MB max)");
  const imageName = await comfyUpload(buffer, `forkfield_${recipe.id}.${m[1] === "jpeg" ? "jpg" : m[1]}`);

  const template = JSON.parse(await fsp.readFile(path.join(ROOT, "workflows", recipe.effect.workflow), "utf8"));
  const workflow = fillWorkflow(template, {
    PHOTO: imageName,
    ENDFRAME_PROMPT: recipe.effect.endframe_prompt,
    MOTION_PROMPT: recipe.effect.motion_prompt,
    DURATION: String(recipe.effect.duration),
    DURATION_INT: recipe.effect.duration,
    SEED: recipe.effect.seed,
  });
  const promptId = await comfyQueue(workflow);
  const job = { id: recipe.id, promptId, recipe, state: "running", started: Date.now() };
  jobs.set(job.id, job);
  return job;
}

async function pollJob(job) {
  if (job.state !== "running") return job;
  const h = await comfyHistory(job.promptId);
  if (!h) return job;
  const status = h.status || {};
  if (status.status_str === "error") {
    const msg = (status.messages || []).find((m) => m[0] === "execution_error")?.[1]?.exception_message;
    job.state = "error";
    job.error = msg || "Generation failed";
    return job;
  }
  if (!status.completed && !Object.keys(h.outputs || {}).length) return job;
  const files = Object.values(h.outputs || {}).flatMap((o) => [...(o.images || []), ...(o.videos || []), ...(o.gifs || [])]);
  const video = files.find((f) => /\.(mp4|webm|mov)$/i.test(f.filename));
  const end = files.find((f) => /\.(png|jpe?g|webp)$/i.test(f.filename));
  if (!video) {
    if (status.completed) Object.assign(job, { state: "error", error: "No video in the output" });
    return job;
  }
  job.state = "finishing";
  try {
    const raw = path.join(CLIPS_DIR, `${job.id}.raw.mp4`);
    await fsp.writeFile(raw, await comfyDownload(video));
    await embedRecipe(raw, path.join(CLIPS_DIR, `${job.id}.mp4`), job.recipe);
    await fsp.rm(raw);
    if (end) await fsp.writeFile(path.join(CLIPS_DIR, `${job.id}.end.png`), await comfyDownload(end));
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "0.1", "-i", path.join(CLIPS_DIR, `${job.id}.mp4`), "-frames:v", "1", "-vf", "scale=360:-2", path.join(CLIPS_DIR, `${job.id}.jpg`)]);
    db.clips.unshift({ ...job.recipe, video: `/clips/${job.id}.mp4`, poster: `/clips/${job.id}.jpg`, seconds: Math.round((Date.now() - job.started) / 1000) });
    await saveDb();
    job.state = "done";
  } catch (e) {
    Object.assign(job, { state: "error", error: e.message });
  }
  return job;
}

// ---------- read the effect of any video ----------
// The browser sends one image with three frames (start | middle | end);
// Qwen3-VL writes the recipe as JSON.

const readJobs = new Map();

function parseRecipeText(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Could not read an effect from this video. Try another clip.");
  const j = JSON.parse(raw.slice(start, end + 1));
  const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const effect = { name: clean(j.name, 60) || "Read effect", endframe_prompt: clean(j.endframe_prompt, 2000), motion_prompt: clean(j.motion_prompt, 2000) };
  if (!effect.endframe_prompt || !effect.motion_prompt) throw new Error("Could not read an effect from this video. Try another clip.");
  return effect;
}

async function startRead(framesBuffer) {
  const id = crypto.randomUUID().slice(0, 8);
  const name = await comfyUpload(framesBuffer, `forkfield_read_${id}.jpg`);
  const template = JSON.parse(await fsp.readFile(path.join(ROOT, "workflows", "forkfield_read_effect.api.json"), "utf8"));
  const promptId = await comfyQueue(fillWorkflow(template, { FRAMES: name }));
  readJobs.set(id, { promptId, started: Date.now(), state: "running" });
  return id;
}

async function pollRead(id) {
  const job = readJobs.get(id);
  if (!job) return { state: "error", error: "Unknown job" };
  if (job.state !== "running") return job;
  const h = await comfyHistory(job.promptId);
  const elapsed = Math.round((Date.now() - job.started) / 1000);
  if (!h) return { state: "running", elapsed };
  if (h.status?.status_str === "error") return Object.assign(job, { state: "error", error: "Reading the video failed. Try another clip." });
  const text = Object.values(h.outputs || {}).flatMap((o) => o.text || [])[0];
  if (!text) return { state: "running", elapsed };
  try {
    Object.assign(job, { state: "done", effect: parseRecipeText(text) });
  } catch (e) {
    Object.assign(job, { state: "error", error: e.message });
  }
  return { ...job, elapsed };
}

// ---------- HTTP ----------

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 40 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("Upload too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function serveFile(res, file, req) {
  try {
    const stat = await fsp.stat(file);
    const type = MIME[path.extname(file)] || "application/octet-stream";
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range && type === "video/mp4") {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : stat.size - 1;
      res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/health") {
      let comfy = false;
      try { comfy = (await fetch(`${COMFY_URL}/api/system_stats`, { headers: comfyHeaders() })).ok; } catch {}
      return send(res, 200, { comfy, comfyUrl: IS_CLOUD ? "Comfy Cloud" : COMFY_URL, engine: ENGINE, apiKey: Boolean(COMFY_API_KEY), dailyLimit: DAILY_LIMIT });
    }
    if (url.pathname === "/api/presets") return send(res, 200, presets);
    if (url.pathname === "/api/clips") return send(res, 200, db.clips);
    if (url.pathname === "/api/generate" && req.method === "POST") {
      const raw = await readBody(req);
      let body;
      if (String(req.headers["content-type"]).startsWith("multipart/form-data")) {
        // Web app sends the photo as a file plus a "meta" JSON field.
        const form = await new Request("http://local/", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: raw }).formData();
        const photo = form.get("photo");
        const type = (photo.type || "image/jpeg").replace("image/jpg", "image/jpeg");
        body = { ...JSON.parse(form.get("meta") || "{}"), photo: `data:${type};base64,${Buffer.from(await photo.arrayBuffer()).toString("base64")}` };
      } else {
        body = JSON.parse(raw.toString("utf8"));
      }
      const job = await startJob(body);
      return send(res, 202, { jobId: job.id, recipe: job.recipe });
    }
    if (url.pathname === "/api/read-effect" && req.method === "POST") {
      const raw = await readBody(req, 12 * 1024 * 1024);
      const form = await new Request("http://local/", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: raw }).formData();
      const frames = form.get("frames");
      if (!frames || typeof frames === "string") throw new Error("Missing frames");
      return send(res, 202, { readId: await startRead(Buffer.from(await frames.arrayBuffer())) });
    }
    const rm = url.pathname.match(/^\/api\/read\/([\w-]+)$/);
    if (rm) return send(res, 200, await pollRead(rm[1]));
    const jm = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (jm) {
      const job = jobs.get(jm[1]);
      if (!job) return send(res, 404, { error: "Unknown job" });
      await pollJob(job);
      const clip = db.clips.find((c) => c.id === job.id);
      return send(res, 200, { state: job.state, error: job.error, elapsed: Math.round((Date.now() - job.started) / 1000), clip });
    }
    if (url.pathname === "/api/inspect" && req.method === "POST") {
      // Reads the recipe out of any uploaded MP4.
      const tmp = path.join(DATA, `inspect_${crypto.randomUUID()}.mp4`);
      await fsp.writeFile(tmp, await readBody(req));
      try {
        const recipe = await readRecipe(tmp);
        return recipe ? send(res, 200, recipe) : send(res, 404, { error: "This video has no Forkfield recipe inside." });
      } finally {
        await fsp.rm(tmp, { force: true });
      }
    }
    if (url.pathname.startsWith("/clips/")) {
      const name = path.basename(url.pathname);
      const own = path.join(CLIPS_DIR, name);
      return serveFile(res, fs.existsSync(own) ? own : path.join(SAMPLES_DIR, name), req);
    }
    if (url.pathname.startsWith("/workflows/")) return serveFile(res, path.join(ROOT, "workflows", path.basename(url.pathname)), req);
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(ROOT, "web", path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    return serveFile(res, file, req);
  } catch (e) {
    send(res, e.status || 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Forkfield → http://localhost:${PORT}  (ComfyUI: ${COMFY_URL}, engine: ${ENGINE}, API key: ${COMFY_API_KEY ? "yes" : "missing"})`);
});
