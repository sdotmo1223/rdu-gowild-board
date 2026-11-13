# RDU GoWild — phone app

A native Android app for the same GoWild board, in **two skins tied to the phone's
theme**: dark mode is FLAP, light mode is GRID. No switcher is drawn anywhere; the
system setting is the switch, and flipping it while the app is open swaps the design
live.

| Theme | Direction | What it is |
|---|---|---|
| **Dark** | `FLAP` | Airport split-flap board: clock cells with a crease, condensed cities, amber read-out, one continuous surface |
| **Light** | `GRID` | Swiss railway timetable: no cards, full-bleed hairlines, section index, one signal red, three strict columns |

No AndroidX, no AppCompat, no Material, no Compose, no Kotlin, no fonts in the APK:
every pixel is drawn with `Canvas` and `Paint` by two classes in
`app/src/main/java/com/freebuff/gowild/designs/`. That is deliberate. The generic look
this is meant to beat comes from default components, and there are none here to inherit.

## Run it

```bash
# 1. build the sample snapshot the app ships with (real capture, rebased forward)
node tools/android-fixture.mjs state.json

# 2. build the APK — no Gradle, see the note below
bash android/build-apk.sh

# 3. install, then just open it: the phone's theme picks the skin
adb -s <serial> install -r android/build/app-debug.apk
adb -s <serial> shell am start -n com.freebuff.gowild/.MainActivity

# development overrides (not reachable from the UI)
adb -s <serial> shell am start -n com.freebuff.gowild/.MainActivity --ei design 3   # pin GRID
adb -s <serial> shell am start -n com.freebuff.gowild/.MainActivity --es theme light --ei design 3 --es capture grid
adb -s <serial> exec-out run-as com.freebuff.gowild cat files/grid.png > grid.png
```

`--es capture <name>` renders the design to a PNG in the app's own files and exits. It
exists because a screenshot taken from outside the app also captures whatever the owner
has floating on their screen — bubbles, media pills — and a design review should not be
a picture of someone's notifications.

The activity logs its decision (`adb logcat -s gowild`), which is how the theme mapping
was verified on the device rather than assumed:

```
I gowild: resolved design=1 night=true forcedTheme=null
```

## Why there is no Gradle build here

Gradle 8.6 + AGP 8.2.2 died twice on this laptop with
`Native memory allocation (malloc) failed … Chunk::new` — at a 1536m and again at a
768m heap, before compiling a single file. The machine has 8 GB and measured ~1.2 GB
free. `build-apk.sh` runs the identical pipeline (`aapt2`, `javac`, `d8`, `zipalign`,
`apksigner`) in a few hundred MB. The Gradle files are kept and are correct for a
machine with memory to spare; they are simply not the path that works here.

Two things the raw pipeline needs that AGP does automatically:

- `aapt2 link` requires `package="…"` in the manifest, so the script writes a build
  copy of it and leaves the source manifest AGP-clean.
- `javac` must be **JDK 17**. JDK 21 compiles fine, then `d8` 8.2.2 throws
  `NullPointerException: String.length() … is null`. The script pins JDK 17.
- `android:debuggable="true"` is set by hand so `adb run-as` can pull the captures.

## The data

The APK ships `assets/board.json`, generated from a **real collector capture**
(`state.json`) by `tools/android-fixture.mjs`, with the days rebased to today and
tomorrow at a 04:00 clock so every row is ahead. Every fare, city and duration is
observed; nothing is invented. Both skins print `SAMPLE` where they report freshness,
because a bundled snapshot is not a live board.

Wiring it to `GET /api/board` is the next step and needs one thing the repository does
not contain: the deployed `workers.dev` origin. The app has no network permission yet.

## Device notes (measured 2026-11-12)

- SM-S918U, **Android 17 / SDK 37**, 1080 × 2316, physical 450 dpi, override 420
  (density 2.625) — the previously recorded "Android 16 / SDK 36" is out of date.
- Wireless debugging works: serial `adb-R5CW1040A1A-Utkq1e._adb-tls-connect._tcp`.
- `android-34` is the only platform installed, so `compileSdk`/`targetSdk` are 34.
- Screenshots: `adb exec-out screencap -p > file` from bash is byte-correct (the
  PowerShell corruption the device notes warn about does not apply to bash redirects).
- The phone was in **night mode** during this work, which is why the default launch
  resolves to FLAP.
