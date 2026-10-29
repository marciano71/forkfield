// Forkfield on Cloudflare Workers: the public demo.
// Same API as server/server.mjs, backed by Comfy Cloud + Workers KV.
// The recipe is appended to each MP4 as a top-level `free` box holding
// "forkfield:" + base64(JSON); players ignore it and the web app reads it.
import presets from "../../../presets/presets.json";
import workflowOpen from "../../../workflows/forkfield_open.api.json";
import workflowPartner from "../../../workflows/forkfield_flf2v.api.json";
import samples from "../../../samples/clips.json";
import workflowRead from "../../../workflows/forkfield_read_effect.api.json";

const COMFY = "https://cloud.comfy.org";
const PREFIX = "forkfield:";
const DURATIONS = [2, 3, 4, 5, 6, 8, 10];
const MODELS = ["Qwen-Image-Edit 2511 + Lightning LoRA (end frame)", "LTX-2.5 22B distilled (first + last frame to video, with audio)"];
const SAMPLE_CLIPS = samples.clips.map((c) => ({ ...c, video: c.video.replace("/clips/", "/samples/clips/"), poster: c.poster.replace("/clips/", "/samples/clips/") }));

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const today = () => new Date().toISOString().slice(0, 10);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") {
        return json({ comfy: true, comfyUrl: "Comfy Cloud", engine: "open", apiKey: Boolean(env.COMFY_API_KEY), dailyLimit: Number(env.DAILY_LIMIT || 0) });
      }
      if (url.pathname === "/api/presets") return json(presets);
      if (url.pathname === "/api/clips") {
        const made = (await env.CLIPS.get("index", "json")) || [];
        return json([...made, ...SAMPLE_CLIPS]);
      }
      if (url.pathname === "/api/generate" && request.method === "POST") return await generate(request, env);
      if (url.pathname === "/api/read-effect" && request.method === "POST") return await readEffect(request, env);
      const rm = url.pathname.match(/^\/api\/read\/([\w-]+)$/);
      if (rm) return await pollRead(rm[1], env);
      const jm = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
      if (jm) return await poll(jm[1], env);
      if (url.pathname === "/api/inspect") return json({ error: "Recipes are read in your browser. Update the page." }, 410);
      if (url.pathname.startsWith("/samples/")) {
        // Static sample clips, re-served with byte ranges for Safari.
        const asset = await env.ASSETS.fetch(new Request(url.toString()));
        if (!asset.ok) return asset;
        return rangeResponse(request, await asset.arrayBuffer(), asset.headers.get("content-type") || "video/mp4");
      }
      const cm = url.pathname.match(/^\/clips\/([\w-]+)\.(mp4|png)$/);
      if (cm) return await serveClip(request, env, cm[1], cm[2]);
      const wm = url.pathname.match(/^\/workflows\/(forkfield_open|forkfield_flf2v)\.api\.json$/);
      if (wm) return json(wm[1] === "forkfield_open" ? workflowOpen : workflowPartner);
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e.message }, e.status || 400);
    }
  },
};

function comfy(path, init = {}, env) {
  return fetch(`${COMFY}${path}`, { ...init, headers: { ...(init.headers || {}), "X-API-Key": env.COMFY_API_KEY } });
}

async function generate(request, env) {
  if (!env.COMFY_API_KEY) throw Object.assign(new Error("This demo is not configured yet."), { status: 503 });
  const form = await request.formData();
  const photo = form.get("photo");
  const meta = JSON.parse(form.get("meta") || "{}");
  if (!photo || typeof photo === "string") throw new Error("Add a photo first");
  if (photo.size > 10 * 1024 * 1024) throw new Error("Photo is too large (10 MB max)");

  // Keep spend predictable: a cap per day and per visitor.
  const day = today();
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const limit = Number(env.DAILY_LIMIT || 30);
  const perIp = Number(env.PER_IP_LIMIT || 3);
  const [used, mine] = await Promise.all([env.CLIPS.get(`count:${day}`), env.CLIPS.get(`ip:${day}:${ip}`)]);
  if (Number(used || 0) >= limit) throw Object.assign(new Error("Today's free clips are gone. Clone the repo and run Forkfield yourself, it takes two commands."), { status: 429 });
  if (Number(mine || 0) >= perIp) throw Object.assign(new Error(`That's ${perIp} clips for you today. Come back tomorrow, or run Forkfield yourself.`), { status: 429 });

  const preset = presets.find((p) => p.id === meta.presetId);
  const o = meta.overrides || {};
  const effect = {
    preset: preset?.id || o.preset || "custom",
    name: String(o.name || preset?.name || "Custom effect").slice(0, 60),
    workflow: "forkfield_open.api.json",
    endframe_prompt: String(o.endframe_prompt || preset?.endframe_prompt || "").slice(0, 2000),
    motion_prompt: String(o.motion_prompt || preset?.motion_prompt || "").slice(0, 2000),
    duration: DURATIONS.includes(Number(o.duration)) ? Number(o.duration) : 5,
    seed: Number.isInteger(o.seed) ? o.seed : preset?.seed ?? 7,
    ...(o.source === "read-from-video" ? { source: "read-from-video" } : {}),
  };
  if (!effect.endframe_prompt || !effect.motion_prompt) throw new Error("Recipe needs both prompts");
  const id = crypto.randomUUID().slice(0, 8);
  const recipe = { forkfield: 1, id, parent: meta.parent || null, author: String(meta.author || "anonymous").slice(0, 40), created: new Date().toISOString(), effect, models: MODELS };

  const up = new FormData();
  up.append("image", photo, `forkfield_${id}.jpg`);
  up.append("overwrite", "true");
  const upRes = await comfy("/api/upload/image", { method: "POST", body: up }, env);
  if (!upRes.ok) throw new Error(`Upload failed (${upRes.status})`);
  const uploaded = await upRes.json();
  const imageName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;

  const workflow = fill(workflowOpen, { PHOTO: imageName, ENDFRAME_PROMPT: effect.endframe_prompt, MOTION_PROMPT: effect.motion_prompt, SEED: effect.seed, DURATION_INT: effect.duration, DURATION: String(effect.duration) });
  const q = await comfy("/api/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: "forkfield-web" }) }, env);
  const qText = await q.text();
  if (!q.ok) throw new Error(`Comfy Cloud rejected the job (${q.status}): ${qText.slice(0, 200)}`);
  const promptId = JSON.parse(qText).prompt_id;

  await Promise.all([
    env.CLIPS.put(`job:${id}`, JSON.stringify({ promptId, recipe, started: Date.now(), state: "running" }), { expirationTtl: 86400 }),
    env.CLIPS.put(`count:${day}`, String(Number(used || 0) + 1), { expirationTtl: 172800 }),
    env.CLIPS.put(`ip:${day}:${ip}`, String(Number(mine || 0) + 1), { expirationTtl: 172800 }),
  ]);
  return json({ jobId: id, recipe }, 202);
}

// Any video: the browser sends three frames (start | middle | end) as one image,
// Qwen3-VL 8B writes the recipe as JSON.
async function readEffect(request, env) {
  if (!env.COMFY_API_KEY) throw Object.assign(new Error("This demo is not configured yet."), { status: 503 });
  const form = await request.formData();
  const frames = form.get("frames");
  if (!frames || typeof frames === "string") throw new Error("Missing frames");
  if (frames.size > 6 * 1024 * 1024) throw new Error("Frames image is too large");
  const day = today();
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `read:${day}:${ip}`;
  const used = Number((await env.CLIPS.get(key)) || 0);
  if (used >= Number(env.PER_IP_LIMIT || 12) * 2) throw Object.assign(new Error("That's a lot of videos read today. Come back tomorrow, or run Forkfield yourself."), { status: 429 });
  const id = crypto.randomUUID().slice(0, 8);
  const up = new FormData();
  up.append("image", frames, `forkfield_read_${id}.jpg`);
  up.append("overwrite", "true");
  const upRes = await comfy("/api/upload/image", { method: "POST", body: up }, env);
  if (!upRes.ok) throw new Error(`Upload failed (${upRes.status})`);
  const u = await upRes.json();
  const workflow = fill(workflowRead, { FRAMES: u.subfolder ? `${u.subfolder}/${u.name}` : u.name });
  const q = await comfy("/api/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: "forkfield-web" }) }, env);
  const qText = await q.text();
  if (!q.ok) throw new Error(`Comfy Cloud rejected the job (${q.status})`);
  await Promise.all([
    env.CLIPS.put(`readjob:${id}`, JSON.stringify({ promptId: JSON.parse(qText).prompt_id, started: Date.now() }), { expirationTtl: 3600 }),
    env.CLIPS.put(key, String(used + 1), { expirationTtl: 172800 }),
  ]);
  return json({ readId: id }, 202);
}

async function pollRead(id, env) {
  const job = await env.CLIPS.get(`readjob:${id}`, "json");
  if (!job) return json({ state: "error", error: "Unknown job" }, 404);
  const elapsed = Math.round((Date.now() - job.started) / 1000);
  const res = await comfy(`/api/jobs/${job.promptId}`, {}, env);
  if (!res.ok) return json({ state: "running", elapsed });
  const j = await res.json();
  if (["failed", "cancelled", "error"].includes(j.status)) return json({ state: "error", error: "Reading the video failed. Try another clip.", elapsed });
  if (j.status !== "completed") return json({ state: "running", elapsed });
  const text = Object.values(j.outputs || {}).flatMap((o) => o.text || [])[0];
  if (!text) return json({ state: "running", elapsed });
  try {
    return json({ state: "done", elapsed, effect: parseRecipeText(text) });
  } catch (e) {
    return json({ state: "error", error: e.message, elapsed });
  }
}

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

async function poll(id, env) {
  const job = await env.CLIPS.get(`job:${id}`, "json");
  if (!job) return json({ error: "Unknown job" }, 404);
  const elapsed = Math.round((Date.now() - job.started) / 1000);
  if (job.state === "done") return json({ state: "done", elapsed: job.seconds, clip: job.clip });
  if (job.state === "error") return json({ state: "error", error: job.error, elapsed });

  const res = await comfy(`/api/jobs/${job.promptId}`, {}, env);
  if (!res.ok) return json({ state: "running", elapsed });
  const j = await res.json();
  if (["failed", "cancelled", "error"].includes(j.status)) {
    job.state = "error";
    job.error = j.execution_error?.exception_message || `Generation ${j.status}`;
    await env.CLIPS.put(`job:${id}`, JSON.stringify(job), { expirationTtl: 86400 });
    return json({ state: "error", error: job.error, elapsed });
  }
  if (j.status !== "completed") return json({ state: "running", elapsed });

  const files = Object.values(j.outputs || {}).flatMap((o) => [...(o.images || []), ...(o.videos || []), ...(o.gifs || [])]);
  const video = files.find((f) => /\.(mp4|webm|mov)$/i.test(f.filename));
  const end = files.find((f) => /\.(png|jpe?g|webp)$/i.test(f.filename));
  if (!video) return json({ state: "error", error: "No video in the output", elapsed });

  const view = (f) => comfy(`/api/view?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || "", type: f.type || "output" })}`, {}, env);
  const [vRes, eRes] = await Promise.all([view(video), end ? view(end) : null]);
  if (!vRes.ok) return json({ state: "running", elapsed });
  const mp4 = withRecipe(new Uint8Array(await vRes.arrayBuffer()), job.recipe);
  await env.CLIPS.put(`clip:${id}.mp4`, mp4);
  if (eRes?.ok) await env.CLIPS.put(`clip:${id}.png`, await eRes.arrayBuffer());

  const clip = { ...job.recipe, video: `/clips/${id}.mp4`, poster: eRes?.ok ? `/clips/${id}.png` : "", seconds: elapsed };
  const index = (await env.CLIPS.get("index", "json")) || [];
  await env.CLIPS.put("index", JSON.stringify([clip, ...index.filter((c) => c.id !== id)].slice(0, 300)));
  await env.CLIPS.put(`job:${id}`, JSON.stringify({ ...job, state: "done", clip, seconds: elapsed }), { expirationTtl: 86400 });
  return json({ state: "done", elapsed, clip });
}

// Appends a top-level MP4 `free` box carrying the recipe. Offsets of the
// existing boxes do not move, so the file stays valid everywhere.
function withRecipe(bytes, recipe) {
  const payload = new TextEncoder().encode(PREFIX + btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(recipe)))));
  const box = new Uint8Array(8 + payload.length);
  new DataView(box.buffer).setUint32(0, box.length);
  box.set([0x66, 0x72, 0x65, 0x65], 4); // "free"
  box.set(payload, 8);
  const out = new Uint8Array(bytes.length + box.length);
  out.set(bytes, 0);
  out.set(box, bytes.length);
  return out;
}

async function serveClip(request, env, id, ext) {
  const data = await env.CLIPS.get(`clip:${id}.${ext}`, "arrayBuffer");
  if (!data) return new Response("Not found", { status: 404 });
  return rangeResponse(request, data, ext === "mp4" ? "video/mp4" : "image/png");
}

function rangeResponse(request, data, type) {
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "public, max-age=31536000, immutable" };
  const range = request.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range && type.startsWith("video/")) {
    // Safari needs byte ranges to play video.
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), data.byteLength - 1) : data.byteLength - 1;
    return new Response(data.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${data.byteLength}`, "content-length": String(end - start + 1) } });
  }
  return new Response(data, { headers: { ...headers, "content-length": String(data.byteLength) } });
}

function fill(template, values) {
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
