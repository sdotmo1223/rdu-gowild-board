#!/usr/bin/env bash
# Build the debug APK without Gradle.
#
# Why this exists: this laptop has 8 GB and measured ~1.2 GB free. Gradle 8.6 + AGP 8.2
# died twice with "Native memory allocation (malloc) failed ... Chunk::new" at both
# 1536m and 768m heaps, before compiling a single file. aapt2 + javac + d8 + apksigner
# build the identical APK in a few hundred MB, and every step is inspectable.
#
#   bash android/build-apk.sh
#
# Output: android/build/app-debug.apk
set -euo pipefail

# JDK 17, not the 21 on PATH: this is the toolchain the device notes pin, and d8 8.2.2
# is built against it.
JDK17="${JDK17:-/c/Program Files/Microsoft/jdk-17.0.20.101-hotspot}"
JAVAC="$JDK17/bin/javac"
SDK="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
HERE="$(cd "$(dirname "$0")" && pwd)"
MAIN="$HERE/app/src/main"
OUT="$HERE/build/raw"
APK="$HERE/build/app-debug.apk"

[ -x "$BT/aapt2.exe" ] || { echo "missing aapt2 under $BT"; exit 1; }
[ -f "$PLATFORM" ] || { echo "missing android.jar at $PLATFORM"; exit 1; }
[ -f "$MAIN/assets/board.json" ] || { echo "run: node tools/android-fixture.mjs"; exit 1; }

rm -rf "$OUT" "$APK"
mkdir -p "$OUT/res" "$OUT/classes" "$OUT/dex" "$HERE/build"

# aapt2 needs the package name inside the manifest; AGP takes it from `namespace` and
# injects it. So the build copy gets it, and the source manifest stays AGP-clean.
python - "$MAIN/AndroidManifest.xml" "$OUT/AndroidManifest.xml" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
if 'package="' not in text.split(">", 1)[0]:
    text = text.replace("<manifest ", '<manifest package="com.freebuff.gowild" ', 1)
open(dst, "w", encoding="utf-8").write(text)
PY

echo "[1/6] aapt2 compile"
"$BT/aapt2.exe" compile --dir "$MAIN/res" -o "$OUT/res/res.zip"

echo "[2/6] aapt2 link"
"$BT/aapt2.exe" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$OUT/AndroidManifest.xml" \
  -A "$MAIN/assets" \
  --min-sdk-version 26 \
  --target-sdk-version 34 \
  --java "$OUT/gen" \
  "$OUT/res/res.zip"

echo "[3/6] javac"
# shellcheck disable=SC2046
"$JAVAC" -source 8 -target 8 -nowarn -classpath "$PLATFORM" -d "$OUT/classes" \
  $(find "$MAIN/java" -name '*.java')

echo "[4/6] d8"
# shellcheck disable=SC2046
"$BT/d8.bat" --lib "$PLATFORM" --min-api 26 --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "[5/6] package"
python - "$OUT/base.apk" "$OUT/dex/classes.dex" "$OUT/unsigned.apk" <<'PY'
import shutil, sys, zipfile
base, dex, out = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.copyfile(base, out)
with zipfile.ZipFile(out, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
PY

echo "[6/6] align + sign"
"$BT/zipalign.exe" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KEYSTORE="${DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
if [ ! -f "$KEYSTORE" ]; then
  echo "      creating debug keystore at $KEYSTORE"
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -keystore "$KEYSTORE" -alias androiddebugkey \
    -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi

"$BT/apksigner.bat" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --out "$APK" "$OUT/aligned.apk"

"$BT/apksigner.bat" verify --print-certs "$APK" | head -3
ls -la "$APK"
