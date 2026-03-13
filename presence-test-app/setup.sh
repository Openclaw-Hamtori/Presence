#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup.sh  —  PresenceTestApp bootstrap
#
# Idempotent: safe to re-run.  Each step is skipped if already complete.
#
# Prerequisites (install before running):
#   1. Xcode 15+           (App Store → search "Xcode")
#   2. Xcode CLI tools     →  xcode-select --install
#   3. CocoaPods           →  brew install cocoapods
#   4. Node 18+            →  brew install node   (Node 25 is fine)
#
# Usage:
#   cd presence-test-app
#   chmod +x setup.sh
#   ./setup.sh
#
# After success:
#   • Open  ios/PresenceTestApp.xcworkspace  in Xcode
#   • Set Signing Team + Bundle Identifier in Xcode → PresenceTestApp target → Signing
#   • Connect iPhone 17 Pro, select it as run destination
#   • Cmd+R  to build and run
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

APP_NAME="PresenceTestApp"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR"               # presence-test-app/
NATIVE_SRC="$ROOT/../presence -mobile-native/ios/PresenceMobile"

# Colour helpers
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅  $*${NC}"; }
info() { echo -e "${CYAN}→   $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️   $*${NC}"; }
fail() { echo -e "${RED}❌  $*${NC}"; exit 1; }

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  PresenceTestApp — setup"
echo "════════════════════════════════════════════════════════════"
echo ""

# ── Step 0: Prerequisites check ───────────────────────────────────────────────

info "Checking prerequisites…"

command -v node  >/dev/null 2>&1 || fail "node not found. Install: brew install node"
command -v npx   >/dev/null 2>&1 || fail "npx not found (comes with node)."
command -v pod   >/dev/null 2>&1 || fail "pod not found. Install: brew install cocoapods"
command -v ruby  >/dev/null 2>&1 || fail "ruby not found (required for xcodeproj gem)."
command -v xcode-select >/dev/null 2>&1 || fail "Xcode CLI tools not found. Run: xcode-select --install"

XCODE_PATH="$(xcode-select -p 2>/dev/null || true)"
[[ "$XCODE_PATH" == *Xcode* ]] || fail "Xcode not found at '$XCODE_PATH'. Install Xcode from the App Store."

ok "Prerequisites satisfied"
echo "   node: $(node --version)  |  pod: $(pod --version)  |  ruby: $(ruby --version | awk '{print $2}')"
echo ""

# ── Step 1: Init React Native project ─────────────────────────────────────────

if [[ -d "$ROOT/ios/$APP_NAME.xcodeproj" ]]; then
  ok "React Native project already initialised (ios/ exists) — skipping init"
else
  info "Initialising React Native 0.74.0 project…"
  info "(this downloads ~200 MB and takes 1-3 min)"
  echo ""

  # We need to init into a temp dir because the CLI refuses to init into a
  # non-empty directory.  We then move only the generated ios/ scaffolding back.
  TMPDIR_RN="$(mktemp -d)"
  trap "rm -rf '$TMPDIR_RN'" EXIT

  # --skip-install  skips npm install in tmpdir (we'll do it in $ROOT)
  npx --yes @react-native-community/cli@latest init "$APP_NAME" \
    --version 0.74.0 \
    --skip-install \
    --directory "$TMPDIR_RN/$APP_NAME" \
    --title "Presence Test"

  # Bring only the ios/ scaffold back (android/ not needed)
  info "Copying generated ios/ scaffold…"
  cp -R "$TMPDIR_RN/$APP_NAME/ios" "$ROOT/ios"

  ok "React Native project initialised"
fi
echo ""

# ── Step 2: npm install ────────────────────────────────────────────────────────

if [[ -d "$ROOT/node_modules/react-native" ]]; then
  ok "node_modules already present — skipping npm install"
else
  info "Installing JS dependencies…"
  cd "$ROOT" && npm install
  ok "JS dependencies installed"
fi
echo ""

# ── Step 3: Copy native Swift/ObjC modules into Xcode target ─────────────────

IOS_TARGET="$ROOT/ios/$APP_NAME"
[[ -d "$IOS_TARGET" ]] || fail "Xcode target dir not found: $IOS_TARGET"

NATIVE_FILES=("PresenceAttestModule.swift" "PresenceAttestModule.m"
              "PresenceHealthKitModule.swift" "PresenceHealthKitModule.m")

COPIED=0
for f in "${NATIVE_FILES[@]}"; do
  src="$NATIVE_SRC/$f"
  dst="$IOS_TARGET/$f"
  if [[ -f "$dst" ]]; then
    warn "$f already in ios/$APP_NAME/ — skipping copy"
  else
    [[ -f "$src" ]] || fail "Native source not found: $src\n    Make sure presence-mobile-native/ is next to presence-test-app/"
    cp "$src" "$dst"
    ok "Copied $f"
    COPIED=$((COPIED + 1))
  fi
done
echo ""

# ── Step 4: Replace Podfile ────────────────────────────────────────────────────

PODFILE="$ROOT/ios/Podfile"
PATCH_PODFILE="$ROOT/ios-patches/Podfile"

if cmp -s "$PODFILE" "$PATCH_PODFILE" 2>/dev/null; then
  ok "Podfile already patched — skipping"
else
  cp "$PATCH_PODFILE" "$PODFILE"
  ok "Podfile replaced with ios-patches/Podfile"
fi
echo ""

# ── Step 5: Patch Info.plist — HealthKit usage description ────────────────────

INFO_PLIST="$IOS_TARGET/Info.plist"
[[ -f "$INFO_PLIST" ]] || fail "Info.plist not found: $INFO_PLIST"

HK_KEY="NSHealthShareUsageDescription"
HK_PRESENT=$(/usr/libexec/PlistBuddy -c "Print :$HK_KEY" "$INFO_PLIST" 2>/dev/null && echo yes || echo no)

if [[ "$HK_PRESENT" == "yes" ]]; then
  ok "NSHealthShareUsageDescription already in Info.plist — skipping"
else
  /usr/libexec/PlistBuddy -c \
    "Add :$HK_KEY string 'Presence reads heart rate data to confirm you are present. Data never leaves your device.'" \
    "$INFO_PLIST"
  ok "Added NSHealthShareUsageDescription to Info.plist"
fi
echo ""

# ── Step 6: Copy entitlements file ────────────────────────────────────────────

ENTITLEMENTS_DST="$IOS_TARGET/$APP_NAME.entitlements"
ENTITLEMENTS_SRC="$ROOT/ios-patches/PresenceTestApp.entitlements"

if [[ -f "$ENTITLEMENTS_DST" ]]; then
  ok "Entitlements file already present — skipping"
else
  cp "$ENTITLEMENTS_SRC" "$ENTITLEMENTS_DST"
  ok "Copied PresenceTestApp.entitlements to ios/$APP_NAME/"
fi
echo ""

# ── Step 7: Patch Xcode project (frameworks + sources + entitlements ref) ─────

XCODEPROJ="$ROOT/ios/$APP_NAME.xcodeproj/project.pbxproj"

# Heuristic: if HealthKit.framework is already in the pbxproj, we've already run
if grep -q "HealthKit.framework" "$XCODEPROJ" 2>/dev/null; then
  ok "Xcode project already patched — skipping add_frameworks.rb"
else
  info "Patching Xcode project (HealthKit, DeviceCheck, native sources, entitlements)…"
  # xcodeproj gem ships with CocoaPods
  ruby "$ROOT/ios-patches/add_frameworks.rb"
fi
echo ""

# ── Step 8: pod install ────────────────────────────────────────────────────────

PODS_DIR="$ROOT/ios/Pods"
if [[ -d "$PODS_DIR" ]]; then
  ok "Pods/ already installed — skipping pod install"
  warn "Run  cd ios && pod install  manually if you changed the Podfile."
else
  info "Running pod install…"
  cd "$ROOT/ios" && pod install
  cd "$ROOT"
  ok "pod install complete"
fi
echo ""

# ── Done ──────────────────────────────────────────────────────────────────────

echo "════════════════════════════════════════════════════════════"
echo -e "${GREEN}  ✅  PresenceTestApp is ready!${NC}"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Open Xcode:"
echo "     open ios/PresenceTestApp.xcworkspace"
echo ""
echo "  2. In Xcode → PresenceTestApp target → Signing & Capabilities:"
echo "     • Set your Apple Developer Team"
echo "     • Set a unique Bundle Identifier (e.g. com.yourname.presencetest)"
echo ""
echo "  3. Connect iPhone 17 Pro via USB. Select it as run destination."
echo ""
echo "  4. Cmd+R to build and run."
echo ""
echo "  ⚠️   App Attest notes:"
echo "     • Does NOT work on Simulator. Physical device only."
echo "     • Entitlement env is 'development' (debug builds)."
echo "     • App must be signed with a valid provisioning profile."
echo ""
