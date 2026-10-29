# ⑂ Forkfield — fork any video

**Higgsfield-style effects, rebuilt on ComfyUI, where every clip is its own source code.**

Higgsfield's moat is its presets: the viral effects live behind a closed app. Forkfield turns that around. Every MP4 it makes carries its full recipe inside the file:

- **Drop a Forkfield clip into Forkfield** → it reads the recipe, you add your photo, and you get the same effect on you. That's a *fork*.
- **Edit the recipe before generating** → you just published a new effect, with a link back to the one you forked.
- **Drop the same clip into ComfyUI** → the whole node graph opens, because ComfyUI's own workflow metadata travels in the file too.

No preset store, no gatekeeper. The video *is* the preset. #OpenSourceHiggsfield

**▶ Demo video (1:40):** https://youtu.be/qAVeIeFBYFM · **Try it:** https://forkfield.estoesmarte.workers.dev · **Post:** https://x.com/Esto_es_Marte/status/2115850109632012499

## How an effect works

```
your photo ──► Qwen-Image-Edit 2511 ──► end frame
     │                                     │
     └──────► LTX-2.5 first + last frame to video (+ audio) ──► clip.mp4 + recipe
```

1. **Qwen-Image-Edit 2511** (4-step Lightning LoRA) draws the final frame from your photo (you on Mars, you as an action figure, you as a museum painting…) keeping your face and pose.
2. **LTX-2.5 22B distilled** animates from your photo to that frame, with sound, following the motion prompt.
3. Forkfield writes the **recipe** into the MP4 and adds the clip to the **fork tree**.

**100% open weights. No partner nodes, no closed APIs.** One ComfyUI graph does it all: [`workflows/forkfield_open.api.json`](workflows/forkfield_open.api.json). On Comfy Cloud a 5-second clip takes about 55 GPU-seconds (≈14 credits).

No big GPU? Set `FORKFIELD_ENGINE=partner` to run the same recipe through the FLUX 3 + LTX-2.5 partner nodes instead ([`workflows/forkfield_flf2v.api.json`](workflows/forkfield_flf2v.api.json)), billed per use from a Comfy API key.

## The recipe format

Stored in the MP4 `comment` tag as `forkfield:` + base64(JSON). It never contains the person's photo.

```json
{
  "forkfield": 1,
  "id": "3f9a12bc",
  "parent": "a71c0e44",
  "author": "marciano",
  "created": "2026-10-28T15:04:00Z",
  "effect": {
    "preset": "portal-to-mars",
    "name": "Portal to Mars (remix)",
    "workflow": "forkfield_open.api.json",
    "endframe_prompt": "Same person from image 1 … on the surface of Mars …",
    "motion_prompt": "The person snaps their fingers. A red portal …",
    "duration": 5,
    "seed": 7
  },
  "models": ["Qwen-Image-Edit 2511 + Lightning LoRA (end frame)", "LTX-2.5 22B distilled (first + last frame to video, with audio)"]
}
```

Read it with nothing but ffprobe:

```bash
ffprobe -v quiet -show_entries format_tags=comment -of csv=p=0 clip.mp4 | sed 's/^forkfield://' | base64 -d
```

## Run it locally

You need **Node 20+**, **ffmpeg** and one of:

- **Comfy Cloud** (easiest): an API key from [platform.comfy.org](https://platform.comfy.org/profile/api-keys) and `COMFY_URL=https://cloud.comfy.org`. All models are already there.
- **Your own ComfyUI** with a ~24 GB+ GPU and the models listed below in `models/`.
- **Your own ComfyUI without a GPU**: `FORKFIELD_ENGINE=partner` plus an API key.

```bash
git clone https://github.com/marciano71/forkfield.git && cd forkfield

cp .env.example .env        # paste COMFY_API_KEY, pick COMFY_URL
node server/server.mjs      # → http://localhost:8190

# Optional: your own ComfyUI instead of Comfy Cloud
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git comfyui
cd comfyui && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python main.py --port 8188
```

Settings live in `.env`:

| Variable | Default | What it does |
|---|---|---|
| `COMFY_API_KEY` | — | Your Comfy key (Comfy Cloud, or partner nodes) |
| `COMFY_URL` | `http://127.0.0.1:8188` | Any ComfyUI server. `https://cloud.comfy.org` runs on Comfy Cloud |
| `FORKFIELD_ENGINE` | `open` | `open` = Qwen-Image-Edit + LTX-2.5 open weights. `partner` = FLUX 3 + LTX-2.5 partner nodes |
| `PORT` | `8190` | Web app port |
| `DAILY_LIMIT` | `0` (none) | Cap on clips per day, for public demos |

## Add an effect

An effect is one entry in [`presets/presets.json`](presets/presets.json): a name, an end-frame prompt and a motion prompt. Open a PR, or just make a clip with an edited recipe and share the MP4: the fork is already the contribution.

## Built with

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and [Comfy Cloud](https://cloud.comfy.org): run every generation
- [LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) by Lightricks (22B distilled, open weights): first + last frame to video, with audio
- [Qwen-Image-Edit 2511](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI) + Lightning 4-step LoRA (open weights): identity-preserving end frames
- Optional partner engine: FLUX 3 Image + LTX-2.5 API

Models used by the open graph (`models/` folder of ComfyUI): `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`, `ltx-2.5-video-vae-bf16.safetensors`, `ltx-2.5-audio-vae-bf16.safetensors`, `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`, `qwen_image_edit_2511_int8_convrot.safetensors`, `qwen_2.5_vl_7b_fp8_scaled.safetensors`, `qwen_image_vae.safetensors`, `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`.
- ffmpeg: recipe embedding and reading
- Plain Node.js and vanilla JS: no build step, no dependencies

Only use photos of people who agreed to it. The sample clips in `samples/` show a fictional person generated for this project with Qwen-Image 2.1 (open weights).

## License

MIT © 2026 ESTOESMARTE SRL. See [LICENSE](LICENSE).
