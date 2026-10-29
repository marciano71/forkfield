// Forkfield front end: pick an effect or drop a clip, add a photo, generate, fork.
const $ = (id) => document.getElementById(id);
const state = { presets: [], clips: [], recipe: null, parent: null, photo: null, job: null };
const GLYPHS = { "portal-to-mars": "◉", "action-figure": "▣", "museum-piece": "▤", "museum-painting": "▤", "outfit-flip": "✦", "earth-zoom-out": "◍", "comic-panel": "✸" };

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- boot ----------
async function boot() {
  const [presets, clips] = await Promise.all([api("/api/presets"), api("/api/clips")]);
  state.presets = presets;
  state.clips = clips;
  renderEffects();
  renderTree();
  try {
    const h = await api("/api/health");
    $("health").innerHTML = h.comfy
      ? `<span class="ok">●</span> Connected to ComfyUI (${h.comfyUrl}) · ${h.engine === "partner" ? "FLUX 3 + LTX-2.5 partner nodes" : "open weights: Qwen-Image-Edit + LTX-2.5"}${h.apiKey ? "" : " · add COMFY_API_KEY to .env to generate"}`
      : `<span class="bad">●</span> ComfyUI is not running at ${h.comfyUrl}. Start it, then reload.`;
  } catch {}
}

function sampleFor(presetId) {
  return state.clips.find((c) => c.effect.preset === presetId && !c.parent);
}

function renderEffects() {
  $("effectGrid").innerHTML = "";
  for (const p of state.presets) {
    const sample = sampleFor(p.id);
    const forks = state.clips.filter((c) => c.effect.preset === p.id).length;
    const card = document.createElement("button");
    card.className = "card";
    card.type = "button";
    card.innerHTML = `
      ${sample ? `<video src="${sample.video}" poster="${sample.poster}" muted loop playsinline preload="none"></video>` : `<div class="art">${GLYPHS[p.id] || "⑂"}</div>`}
      ${forks ? `<span class="badge">⑂ ${forks}</span>` : ""}
      <div class="meta"><strong>${esc(p.name)}</strong><span>${esc(p.tagline)}</span></div>`;
    const v = card.querySelector("video");
    if (v) {
      card.addEventListener("mouseenter", () => v.play().catch(() => {}));
      card.addEventListener("mouseleave", () => v.pause());
      new IntersectionObserver(([e]) => (e.isIntersecting && matchMedia("(hover: none)").matches ? v.play().catch(() => {}) : null)).observe(card);
    }
    card.addEventListener("click", () => openSheet({ recipe: presetRecipe(p) }));
    $("effectGrid").append(card);
  }
}

function presetRecipe(p) {
  return { effect: { preset: p.id, name: p.name, endframe_prompt: p.endframe_prompt, motion_prompt: p.motion_prompt, duration: p.duration, seed: p.seed } };
}

function renderTree() {
  const box = $("treeList");
  if (!state.clips.length) return;
  const byId = Object.fromEntries(state.clips.map((c) => [c.id, c]));
  const kids = {};
  const roots = [];
  for (const c of state.clips) {
    if (c.parent && byId[c.parent]) (kids[c.parent] ||= []).push(c);
    else roots.push(c);
  }
  const node = (c) => {
    const wrap = document.createElement("div");
    const from = c.parent && !byId[c.parent] ? ` · forked from ${esc(c.parent)} (made elsewhere)` : "";
    wrap.innerHTML = `
      <div class="node">
        <img src="${c.poster}" alt="" loading="lazy">
        <div class="grow">
          <div class="what">${esc(c.effect.name)}</div>
          <div class="who">by ${esc(c.author || "anonymous")} · ${new Date(c.created).toLocaleString()}${from}</div>
        </div>
        <button class="ghost small" type="button">⑂ Fork</button>
      </div>`;
    wrap.querySelector("img").addEventListener("click", () => showClip(c));
    wrap.querySelector("button").addEventListener("click", () => openSheet({ recipe: c, parent: c.id }));
    if (kids[c.id]) {
      const ch = document.createElement("div");
      ch.className = "children";
      kids[c.id].forEach((k) => ch.append(node(k)));
      wrap.append(ch);
    }
    return wrap;
  };
  box.innerHTML = "";
  roots.forEach((r) => box.append(node(r)));
}

// ---------- sheet ----------
function openSheet({ recipe, parent = null }) {
  state.recipe = recipe;
  state.parent = parent;
  const e = recipe.effect;
  $("sheetKicker").textContent = parent ? "Fork" : "New clip";
  $("sheetTitle").textContent = e.name;
  $("forkOf").hidden = !parent;
  if (parent) $("forkOf").innerHTML = `⑂ Forking <strong>${esc(e.name)}</strong> by ${esc(recipe.author || "anonymous")}. Same recipe, your photo. Edit it to make your own version.`;
  $("fEnd").value = e.endframe_prompt;
  $("fMotion").value = e.motion_prompt;
  $("fDuration").value = String(e.duration || 5);
  $("fSeed").value = e.seed ?? 7;
  $("fAuthor").value = localGet("ff_author") || "";
  showStep("stepCreate");
  updateGo();
  $("sheet").showModal();
}

function showStep(id) {
  for (const s of ["stepCreate", "stepWait", "stepDone"]) $(s).hidden = s !== id;
  $("errorBox").hidden = true;
}

function updateGo() {
  $("goBtn").disabled = !state.photo;
}

$("photoInput").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  state.photo = await toDataUrl(file);
  $("photoPreview").src = state.photo;
  $("photoPreview").hidden = false;
  $("photoHint").innerHTML = `<strong>Photo ready</strong><br>Tap to change it.`;
  updateGo();
});

$("goBtn").addEventListener("click", async () => {
  const author = $("fAuthor").value.trim();
  localSet("ff_author", author);
  const e = state.recipe.effect;
  const overrides = {
    preset: e.preset,
    name: e.name,
    endframe_prompt: $("fEnd").value.trim(),
    motion_prompt: $("fMotion").value.trim(),
    duration: Number($("fDuration").value),
    seed: parseInt($("fSeed").value, 10),
  };
  const edited = overrides.endframe_prompt !== e.endframe_prompt || overrides.motion_prompt !== e.motion_prompt;
  if (edited && !/remix/i.test(overrides.name)) overrides.name = `${e.name} (remix)`;
  try {
    showStep("stepWait");
    tick(0);
    const { jobId } = await api("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: state.photo, presetId: e.preset, overrides, parent: state.parent, author: author || "anonymous" }),
    });
    await waitFor(jobId);
  } catch (err) {
    fail(err.message);
  }
});

async function waitFor(jobId) {
  for (;;) {
    await sleep(3000);
    const j = await api(`/api/jobs/${jobId}`);
    tick(j.elapsed);
    if (j.state === "done") return showClip(j.clip, true);
    if (j.state === "error") throw new Error(j.error);
  }
}

function tick(sec) {
  $("waitTime").textContent = `${sec}s`;
  $("waitTitle").textContent = sec < 20 ? "Drawing your final frame with Qwen-Image-Edit…" : sec < 80 ? "Animating with LTX-2.5…" : "Packing the recipe into your clip…";
}

function showClip(clip, fresh = false) {
  state.clips = fresh ? [clip, ...state.clips.filter((c) => c.id !== clip.id)] : state.clips;
  if (fresh) { renderEffects(); renderTree(); }
  $("sheetKicker").textContent = fresh ? "Done" : "Clip";
  $("sheetTitle").textContent = clip.effect.name;
  $("forkOf").hidden = true;
  $("resultVideo").src = clip.video;
  $("dlBtn").href = clip.video;
  $("dlBtn").setAttribute("download", `forkfield-${clip.effect.preset}-${clip.id}.mp4`);
  const { video, poster, seconds, ...recipe } = clip;
  $("recipeJson").textContent = JSON.stringify(recipe, null, 2);
  $("wfBtn").href = `/workflows/${clip.effect.workflow}`;
  $("forkAgain").onclick = () => openSheet({ recipe: clip, parent: clip.id });
  showStep("stepDone");
  if (!$("sheet").open) $("sheet").showModal();
}

function fail(msg) {
  showStep("stepCreate");
  $("errorBox").textContent = msg;
  $("errorBox").hidden = false;
}

$("sheet").addEventListener("close", () => $("resultVideo").pause());

// ---------- drop a clip to fork ----------
const drop = $("drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) inspect(e.dataTransfer.files[0]); });
$("dropInput").addEventListener("change", (e) => e.target.files[0] && inspect(e.target.files[0]));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer?.files[0]?.type.startsWith("video")) inspect(e.dataTransfer.files[0]); });

// The recipe sits in the MP4 metadata as "forkfield:" + base64(JSON).
// We find it by scanning the file bytes right here in the browser.
async function readRecipeLocally(file) {
  const PREFIX = "forkfield:";
  const B64 = /[A-Za-z0-9+/=]/;
  // Recipes live in the moov box, which faststart puts near the start; fall back to the tail.
  const chunks = [file.slice(0, 4 * 1024 * 1024), file.slice(Math.max(0, file.size - 4 * 1024 * 1024))];
  for (const chunk of chunks) {
    const text = new TextDecoder("latin1").decode(await chunk.arrayBuffer());
    let at = text.indexOf(PREFIX);
    while (at !== -1) {
      let end = at + PREFIX.length;
      while (end < text.length && B64.test(text[end])) end++;
      try {
        const json = new TextDecoder().decode(Uint8Array.from(atob(text.slice(at + PREFIX.length, end)), (c) => c.charCodeAt(0)));
        const recipe = JSON.parse(json);
        if (recipe.forkfield && recipe.effect) return recipe;
      } catch {}
      at = text.indexOf(PREFIX, end);
    }
  }
  return null;
}

async function inspect(file) {
  $("health").textContent = "Reading the recipe…";
  try {
    const recipe = (await readRecipeLocally(file)) || (await api("/api/inspect", { method: "POST", body: file }));
    $("health").textContent = "";
    openSheet({ recipe, parent: recipe.id });
  } catch (err) {
    $("health").innerHTML = `<span class="bad">●</span> ${esc(err.message)}`;
  }
}

// ---------- utils ----------
function toDataUrl(file) {
  // Downscale big photos so uploads stay fast.
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.92));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

boot();
