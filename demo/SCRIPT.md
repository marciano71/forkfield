# Forkfield demo: voiceover (English, ~110 s)

1. HOOK
Higgsfield said they'd open source their platform. We took them at their word, and went one step further: what if every video was its own source code?

2. THE APP
This is Forkfield. Pick an effect, add a photo, and in about a minute you get a vertical clip, with sound.

3. SIX EFFECTS
Portal to Mars. Action figure. Museum piece. Outfit flip. Earth zoom out. Comic panel. Six recipes to start.

4. THE TWIST
On Higgsfield, the effect is the product, and it stays locked inside their app. In Forkfield, the recipe ships inside the MP4 itself.

5. FORK IT
See a clip you like? Drop it in. Forkfield reads the recipe right in your browser, so the file never leaves your device. Add your own photo, and you've forked it. Change one line of the recipe, and you've made a brand new effect, linked back to the one it came from. Every fork lands in the fork tree.

6. HOW IT'S BUILT
Under the hood it's one ComfyUI graph, open weights only. Qwen Image Edit draws your final frame and keeps your face. LTX two point five animates from your photo to that frame, with audio. On Comfy Cloud, a clip takes under a minute of GPU. The graph rides inside the file too, and the public demo runs on Cloudflare Workers.

7. CLOSE
No preset store. No gatekeeper. The video is the preset. Forkfield: fork any video. MIT licensed, on GitHub now.
