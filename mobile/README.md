# Ledger — Android app

There are two real ways to get this running as an installable Android app.
Neither can be done inside this chat — both need a step you run on your own
computer or a browser-based tool — but both produce a genuine `.apk`/`.aab`
you can install on a phone or publish to the Play Store.

**Which one should I use?**
- Just want an app icon on your phone that opens Ledger full-screen, no
  browser address bar? → **Option A (PWABuilder)**. Takes about 10 minutes,
  no coding tools installed on your computer at all.
- Want to publish it on the Google Play Store, or add native phone features
  later (push notifications, biometric unlock, etc.)? → **Option B
  (Capacitor)**. Takes longer to set up, needs Android Studio.

Both options load your **live, already-deployed** Flask app inside a native
Android shell — they don't reimplement anything. Whatever works on the
website works in the app, automatically, including new features you add
later (just redeploy the website as normal — no app update needed for
website-side changes).

---

## Before either option: make sure the site is ready

This project already has everything a PWA/Android wrapper needs — a web
manifest (`static/site.webmanifest`), a service worker (`static/sw.js`),
and icons at every required size (`static/icons/`). Just make sure:

1. Your Render deployment is live and working over **HTTPS** (Render gives
   you this by default — `https://your-app-name.onrender.com`).
2. Open that URL on an Android phone in Chrome first, and confirm you see
   an "Install app" option in Chrome's menu (⋮ → "Install app" or "Add to
   Home screen"). If that works, you're ready for either option below.

---

## Option A — PWABuilder (fastest, no local tools)

1. Go to **[pwabuilder.com](https://www.pwabuilder.com)** in a browser.
2. Enter your live URL (`https://your-app-name.onrender.com`) and click
   **Start**.
3. PWABuilder scans the site and shows a report card for Manifest, Service
   Worker, and Icons. All three should already score well because of the
   files mentioned above. Fix anything it flags (it'll tell you exactly
   what and why).
4. Click **Package for stores** → **Android**.
5. Leave the defaults (package ID, app name "Ledger") unless you want to
   customize them, then click **Generate**.
6. Download the generated package — you'll get a signed `.apk` (installs
   directly) and/or `.aab` (for uploading to Google Play).
7. To install the `.apk` on a phone: transfer it to the device (email,
   Drive, USB) and open it. You'll need to allow "Install unknown apps"
   for whichever app you used to open the file — Android will prompt you
   the first time.

That's it — you now have a real Android app icon that launches Ledger
full-screen, works from the home screen, and behaves like an installed app.

> **Note:** this generates what's called a Trusted Web Activity (TWA) —
> it's a genuine Android app (not "just a bookmark"), it's the same
> technology Google uses for many Play Store apps that are built from a
> website, and it's fully eligible for Play Store publishing if you want
> that later (PWABuilder can also generate the Play Store submission
> package directly).

---

## Option B — Capacitor (for Play Store / native features / full control)

This wraps the live site in a proper Android Studio project you build and
sign yourself. Needs to be done on a computer with:
- [Node.js](https://nodejs.org) (which includes npm)
- [Android Studio](https://developer.android.com/studio)

### 1. Point the config at your live site

Open `mobile/capacitor.config.json` in this project and replace
`YOUR-APP-NAME` with your actual Render app name:

```json
"server": {
  "url": "https://your-actual-app-name.onrender.com",
  ...
}
```

### 2. Install dependencies and scaffold the Android project

From inside the `mobile/` folder:

```bash
cd mobile
npm install
npx cap add android
```

This creates a full `mobile/android/` Gradle project — a real Android
Studio project — configured to load your live URL. (This step needs
network access to npm's registry, which is why it has to run on your own
machine rather than in this chat.)

### 3. Open and build in Android Studio

```bash
npx cap open android
```

This launches Android Studio with the project loaded. From there:
- **Run ▶** on a connected phone or emulator to test it immediately.
- **Build → Generate Signed Bundle / APK** to produce a release `.apk` or
  `.aab` you can install directly or upload to the Play Store. Android
  Studio will walk you through creating a signing key the first time —
  keep that keystore file safe, you'll need the same one for every future
  update.

### 4. After you change the website

Since the app just loads your live URL, most changes (new features, bug
fixes, UI tweaks) need **no app rebuild at all** — redeploy to Render and
the app picks it up automatically next time it's opened. You'd only need
to rebuild the Android app itself for things like: changing the app icon,
app name, permissions, or adding a native plugin.

---

## What's in `mobile/`

```
mobile/
├── package.json            # Capacitor CLI + Android platform dependencies
├── capacitor.config.json   # app id, app name, and the live URL it loads
└── www/index.html          # placeholder Capacitor requires — never shown;
                             # the app loads capacitor.config.json's server.url instead
```

`mobile/android/` doesn't exist yet — `npx cap add android` generates it
on your machine in step 2 above. It's a full Gradle project, which is why
it isn't something that can be handed to you pre-built from here.
