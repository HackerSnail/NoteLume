#!/bin/sh
# 重打 macOS dmg：npm run build 出来的 NoteLume.app 是 linker-signed，直接组卷分发会报「已损坏」，
# 必须先补一次 ad-hoc 签名；卷内文件在签名之后放进 stage，不参与签名校验。
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
bundle="$root/src-tauri/target/release/bundle"
app="$bundle/macos/NoteLume.app"
[ -d "$app" ] || { echo "找不到 $app，先跑 npm run build"; exit 1; }

version=$(sed -n 's/.*"version"[: ]*"\([^"]*\)".*/\1/p' "$root/src-tauri/tauri.conf.json" | head -1)
dmg="$bundle/dmg/NoteLume_${version}_aarch64.dmg"

codesign --force --deep -s - "$app"

stage="$root/tmp/dmg-stage"
rm -rf "$stage"
mkdir -p "$stage"
cp -R "$app" "$stage/NoteLume.app"
ln -s /Applications "$stage/Applications"
cp "$root/docs/macOS打开说明.txt" "$stage/打开说明.txt"
find "$stage" -name .DS_Store -delete

hdiutil create -volname NoteLume -srcfolder "$stage" -ov -format UDZO "$dmg"
echo "$dmg"
