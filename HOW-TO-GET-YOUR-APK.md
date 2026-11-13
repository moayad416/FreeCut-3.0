# FreeCut Mobile — Build your APK (one-time, ~10 minutes)

You don't need to install anything on your computer. The APK is built for free
in the cloud by GitHub. Follow these steps exactly.

## Step 1 — Create a free GitHub account (if you don't have one)

1. Go to https://github.com and sign up (free).

## Step 2 — Put this project on GitHub

1. Go to https://github.com/new
2. Repository name: `freecut-mobile` → keep **Public** → click **Create repository**.
3. On the next page click **"uploading an existing file"**.
4. Open this folder on your computer, select **everything inside it**
   (the `app` folder, `.github` folder, `build.gradle`, `settings.gradle`, etc.)
   and drag them onto the page.
   - Tip: if `.github` doesn't upload because it starts with a dot, upload it
     separately — the build button will not appear without it.
5. Click the green **Commit changes** button.

## Step 3 — Build the APK

1. In your repository, click the **Actions** tab (top menu).
2. If GitHub asks, click **"I understand my workflows, go ahead and enable them"**.
3. On the left, click **"Build FreeCut APK"**, then the **"Run workflow"**
   button on the right → green **Run workflow**.
4. Wait 5–10 minutes. When it finishes with a green checkmark, click the run,
   scroll down to **Artifacts**, and download **FreeCut-Android** (a ZIP file).
5. Open the ZIP — inside is **app-debug.apk**. That's your app.

## Step 4 — Install on your phone

1. Send **app-debug.apk** to your phone (email it to yourself, Google Drive,
   WhatsApp "send to yourself", or USB cable).
2. Tap the APK file on the phone. Android will ask to allow installing from
   this source — tap **Allow/Settings → Allow from this source → Install**.
3. Done — **FreeCut** appears in your apps. ✂

## Using the app (v2)

- **＋ Video** — add clips **or photos** from your gallery (you can pick several
  at once). Photos become still clips you can stretch to any length.
- **🖼 Image** — the free AI image maker: describe a picture, pick a style
  (or leave it on ✨ Any and it reads the style from your words), and add it
  straight to your movie. Works with no key (pollinations.ai); saving a free
  Gemini key in 🤖 AI → Settings gives bigger, more accurate pictures.
- Drag a clip's **edges** to trim it · drag a clip **sideways** to reorder
- Tap a clip → adjust **speed, volume, brightness, contrast, saturation, B&W**
- **✂ Split** — cuts the clip at the play position
- **🅣 Text** — captions with 9 positions, colors, box, timing
- **💬 Captions** — auto-captions from speech (free Groq key), now with exact
  word timing and automatic splitting of long videos into 10-minute pieces
- **♫ Music** — add a background track, set its volume
- **Export** — choose Draft / HD / Full HD / **📱 TikTok · Reels · Shorts
  (vertical)** / **⬛ Square (Instagram)** → **Save video** → it lands in
  your **Gallery → Movies → FreeCut**

## Notes

- The **first export** downloads the video engine (~25 MB) once; after that it
  is cached and exports work offline. All video processing happens **on your
  phone** — your videos are never uploaded anywhere.
- Rebuilding after you change files: push the changes, then run the workflow
  again from the Actions tab.

## Rebuild from scratch (optional)

If you prefer building locally and have Android Studio: open this folder in
Android Studio and press ▶ Run — that's it.
