# Photonic Wallet — Native iOS / Android (Capacitor)

The same Vite/React bundle that powers the web app and the Tauri desktop build
is wrapped with [Capacitor](https://capacitorjs.com) **8** to ship native iOS
and Android apps. This document covers the setup, the build pipeline, and how to
produce a release IPA / APK.

> **Important:** the native *projects* and all configuration live in the repo
> and build green, but producing an installable **IPA/APK requires a full native
> toolchain** (Xcode for iOS, Android Studio + JDK for Android). Those tools are
> **not** installed on the machine where this was set up — see
> [Prerequisites](#prerequisites). Everything up to "open in IDE" is done and
> verified; the final device build is the one step that must run on a fully
> provisioned Mac / dev box.

---

## What's in the box

| Path | Purpose |
| --- | --- |
| `capacitor.config.ts` | App id (`org.radiantcore.photonic`), name, `webDir: dist`, SplashScreen config |
| `ios/` | Generated Xcode project (Swift Package Manager — **no CocoaPods**) |
| `android/` | Generated Gradle project |
| `src/platform/` | Platform abstraction: clipboard, share, file save, QR photo-scan, status bar / splash init |
| `src/stubs/` | Inert stand-ins for the PWA virtual modules (the service worker is disabled on native) |
| `src/config/csp.ts` → `CAPACITOR_CSP` | WebView-tuned Content-Security-Policy injected at build time |

The web/Tauri builds are unchanged — every native code path is gated behind
`Capacitor.isNativePlatform()` (false on web) or the `CAP_BUILD=1` build flag.

---

## Prerequisites

Capacitor 8 targets **iOS 15+** and **Android SDK 24+** (pinned in
`ios/App/CapApp-SPM/Package.swift` / the Xcode project and `android/variables.gradle`).

| Tool | Needed for | Status on this machine |
| --- | --- | --- |
| Node ≥ 20 | everything | ✅ (v26) |
| pnpm | dependency mgmt | ✅ (11.1.3) |
| **Xcode** (full, from the App Store) | iOS build, simulator, IPA | ❌ only Command Line Tools present |
| iOS device / Apple Developer account | signing, device install | — |
| **Android Studio** + Android SDK | Android build, emulator, APK/AAB | ❌ not installed |
| **JDK 21** | Gradle build | ❌ not installed |

> Capacitor 8 iOS uses **Swift Package Manager**, so CocoaPods is **not**
> required. (Capacitor ≤ 6 needed it; we're past that.)

Install what's missing:

```bash
# iOS — install Xcode from the App Store, then:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept

# Android — install Android Studio, then a JDK (e.g. Temurin 21) + the SDK.
# Set the env so Gradle/Capacitor can find the SDK:
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

---

## Build pipeline

One script does the whole web→native sync:

```bash
pnpm -F @photonic/app build:mobile
# = CAP_BUILD=1 vite build  &&  cap copy  &&  cap sync
```

`CAP_BUILD=1` changes the Vite build in two ways (see `vite.config.ts`):

1. **Drops the PWA service worker.** It caches stale assets and misbehaves
   under the `capacitor://localhost` (iOS) and `http://localhost` (Android)
   schemes. `ReloadPrompt`'s `virtual:pwa-register/*` imports are aliased to the
   inert stubs in `src/stubs/`.
2. **Injects a WebView CSP** `<meta>` tag (native bundles have no HTTP server to
   set a real header). It mirrors the canonical web policy but adds the
   Capacitor origins, adds `media-src … mediastream:` for the live camera
   scanner, widens `worker-src` to `'self' blob:`, and **drops
   `upgrade-insecure-requests`** (which would break Android's `http://localhost`
   origin).

Convenience scripts:

```bash
pnpm -F @photonic/app cap:sync         # cap sync (after a build)
pnpm -F @photonic/app cap:ios          # cap open ios     (opens Xcode)
pnpm -F @photonic/app cap:android      # cap open android (opens Android Studio)
pnpm -F @photonic/app cap:add:ios      # re-scaffold ios/ if deleted
pnpm -F @photonic/app cap:add:android  # re-scaffold android/ if deleted
```

---

## Open in Xcode / Android Studio

```bash
pnpm -F @photonic/app build:mobile     # always build first

# iOS
pnpm -F @photonic/app cap:ios          # opens ios/App/App.xcworkspace in Xcode

# Android
pnpm -F @photonic/app cap:android      # opens android/ in Android Studio
```

---

## Release builds

### Android — APK / AAB

1. Generate a signing keystore (once):
   ```bash
   keytool -genkey -v -keystore photonic-release.keystore \
     -alias photonic -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Reference it from `android/key.properties` + `android/app/build.gradle`
   (`signingConfigs`), per the
   [Capacitor Android signing guide](https://capacitorjs.com/docs/android/deploying-to-google-play).
3. Build:
   ```bash
   cd packages/app/android
   ./gradlew assembleRelease     # -> app/build/outputs/apk/release/app-release.apk
   ./gradlew bundleRelease       # -> app/build/outputs/bundle/release/app-release.aab  (Play Store)
   ```
   Or in Android Studio: **Build ▸ Generate Signed Bundle / APK**.

### iOS — IPA

1. Open the workspace: `pnpm -F @photonic/app cap:ios`.
2. In Xcode, select the **App** target ▸ **Signing & Capabilities**, set your
   Team and a unique bundle id (defaults to `org.radiantcore.photonic`).
3. Set the version/build numbers, then **Product ▸ Archive** ▸ **Distribute App**
   to export an IPA / upload to App Store Connect.
   - Headless: `xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
     -configuration Release -archivePath build/App.xcarchive archive`.

---

## Web-API compatibility — what changed and why

The WebView is not a full browser. These web APIs were routed through the
`src/platform/` abstraction (native plugin on iOS/Android, web fallback
elsewhere):

| Concern | Web API (breaks in WebView) | Native handling | Call sites updated |
| --- | --- | --- | --- |
| **Clipboard** | `navigator.clipboard.{read,write}Text` (gesture-gated / rejected in WKWebView) | `@capacitor/clipboard` | `Connect.tsx`, `WaveNames.tsx`, `OpenOrders.tsx`, `RecoveryPhrase.tsx` |
| **File save / export** | `<a download>` (no-op in WKWebView) | `@capacitor/filesystem` (write to Cache) + `@capacitor/share` (share sheet) | `DownloadLink.tsx`, `Vault.tsx` (vault export) |
| **Share** | `navigator.share` (often absent) | `@capacitor/share` | `WalletSettings.tsx` |
| **QR scan** | `getUserMedia` live scanner | works in WebView with camera permission; **+** still-photo fallback via `@capacitor/camera` + `jsQR` | `AddressInput.tsx` (+ existing `Connect.tsx` live scanner) |
| **Status bar / splash** | DOM fullscreen / theme-color don't apply | `@capacitor/status-bar`, `@capacitor/splash-screen` | `main.tsx` → `initNative()` |
| **OPFS tx cache** | `navigator.storage.getDirectory` undefined on iOS < 16.4 → throws | feature-guarded no-op | `opfs.ts` |
| **Safe-area insets** | content under the notch / home indicator | `viewport-fit=cover` + `html.capacitor` safe-area padding | `index.html`, `index.css`, `initNative()` |

Storage (`localStorage`, IndexedDB/Dexie, `BroadcastChannel`) works as-is in the
WebView and persists (no Safari ITP 7-day eviction inside a native app). The
AEAD-encrypted seed handling is unchanged — nothing about the key ever touches a
native plugin.

File exports go through the share sheet from the **app-private cache**
(`Directory.Cache`), never a world-readable path. On iOS the temp file is deleted
once the share completes; on Android it's left to OS cache eviction (deleting it
immediately can truncate a receiving app's lazy `content://` read).

### Documented WebView quirks (no code needed)

- **iOS Safari / WKWebView has no Pointer Lock** (`requestPointerLock`/`exitPointerLock`
  throw). The wallet doesn't use it — noted for completeness.
- **iOS Safari / WKWebView has no DOM Fullscreen.** We use the StatusBar plugin
  for chrome styling instead of `requestFullscreen`.
- **`radiantjs` `Message.sign` is non-deterministic** — fine; signatures are
  still valid, only not reproducible byte-for-byte.

---

## On-device verification checklist

These could not be exercised here (no device/simulator). Run them on first build:

- [ ] App launches past the splash to the wallet UI (no white screen → CSP OK).
- [ ] No CSP violations in the WebView console (Safari Web Inspector / Chrome
      `chrome://inspect`). ElectrumX `wss://…:50022` connects and the wallet syncs.
- [ ] **Live QR scan** (Send / Connect): camera permission prompt appears, scan
      fills the address. On denial, **"Scan from photo"** (native fallback) works.
- [ ] **Copy / paste**: copy an address, "Paste from clipboard" on Connect pastes it.
- [ ] **Vault export** and any token **Download**: the OS share sheet appears and
      the file saves to Files / Drive.
- [ ] Status bar text is legible (light) over the dark canvas; content clears the
      notch and the home indicator.
- [ ] Background → foreground keeps the session (auto-lock behaves).
