#!/usr/bin/env bash
#
# test.sh — headless Chromium smoke test for Mandelbrot Explorer.
#
# What it does:
#   1. Ensures a static server is running on PORT (starts it if not).
#      It NEVER stops the server — it is left running for you to open in a
#      browser at http://localhost:9000/.
#   2. Loads the app in headless Chromium with software WebGL2 (SwiftShader),
#      so it works on machines without a GPU.
#   3. Writes a screenshot + a DOM dump into ./test-output/ and runs a few
#      assertions (set rendered, palettes listed, info bar populated, no boot
#      error overlay).
#
# Re-runnable and safe to call repeatedly. Requires: python3, chromium.

set -u

PORT=9000
URL="http://localhost:${PORT}/"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${ROOT}/test-output"
SHOT="${OUT_DIR}/screenshot.png"
DOM="${OUT_DIR}/dom.html"

mkdir -p "${OUT_DIR}"

# Tiny helper: is the server answering on PORT?
server_up() {
	python3 - "$PORT" <<-'PY' 2>/dev/null
	import sys, urllib.request
	urllib.request.urlopen("http://localhost:%s/" % sys.argv[1], timeout=2)
	PY
}

# --- 1. Ensure the server is running (start if needed; never kill it). --------
if server_up; then
	echo "server: already running on ${PORT}"
else
	echo "server: starting on ${PORT} (left running after this script exits)"
	( cd "${ROOT}" && nohup python3 -m http.server "${PORT}" >/dev/null 2>&1 & )
	for _ in $(seq 1 20); do
		server_up && break
		sleep 0.25
	done
	server_up || { echo "error: server failed to start on ${PORT}"; exit 1; }
fi

# Common headless flags. SwiftShader gives WebGL2 without a real GPU.
CHROME_FLAGS=(
	--headless=new
	--no-sandbox
	--disable-gpu
	--enable-unsafe-swiftshader
	--use-gl=angle
	--use-angle=swiftshader
	--window-size=900,600
)

# --- 2a. Screenshot (virtual-time lets the rAF loop draw a frame first). ------
chromium "${CHROME_FLAGS[@]}" \
	--virtual-time-budget=2500 \
	--screenshot="${SHOT}" \
	"${URL}" >"${OUT_DIR}/chrome-screenshot.log" 2>&1

# --- 2b. DOM dump (after scripts run and build the UI). -----------------------
chromium "${CHROME_FLAGS[@]}" \
	--virtual-time-budget=1500 \
	--dump-dom \
	"${URL}" >"${DOM}" 2>"${OUT_DIR}/chrome-dom.log"

# --- 3. Assertions. ----------------------------------------------------------
fail=0
check() { # check <description> <test-exit-status>
	if [ "$2" -eq 0 ]; then echo "  ok   - $1"; else echo "  FAIL - $1"; fail=1; fi
}

echo "results:"
[ -s "${SHOT}" ] && [ "$(wc -c <"${SHOT}")" -gt 5000 ]; check "screenshot rendered (non-blank PNG)" $?
for palette in Plasma Fire Ocean Aurora; do
	grep -Fq "class=\"palette-name\">${palette}" "${DOM}"
	check "palette '${palette}' listed" $?
done
! grep -Fq 'class="palette-name">Rainbow' "${DOM}"; check "palette 'Rainbow' not listed" $?
python3 - "${DOM}" <<-'PY'
	import pathlib, re, sys
	dom = pathlib.Path(sys.argv[1]).read_text()
	match = re.search(r'<ul id="palette-list"[^>]*>.*?<li class="palette-item active">.*?<span class="palette-name">([^<]+)</span>', dom, re.S)
	raise SystemExit(0 if match and match.group(1) == 'Plasma' else 1)
PY
check "palette 'Plasma' active by default" $?
python3 - "${DOM}" <<-'PY'
	import pathlib, re, sys
	dom = pathlib.Path(sys.argv[1]).read_text()
	match = re.search(r'<ul id="engine-list"[^>]*>.*?<li class="palette-item active">.*?<span class="palette-name">([^<]+)</span>', dom, re.S)
	raise SystemExit(0 if match and match.group(1) == 'Orbit' else 1)
PY
check "engine 'Orbit' active by default" $?
grep -q 'id="info-zoom"[^>]*>[0-9]' "${DOM}";    check "info bar zoom populated" $?
grep -q 'id="info-iter"[^>]*>[0-9]' "${DOM}";    check "info bar iterations populated" $?
grep -q 'id="error-overlay"[^>]*hidden' "${DOM}"; check "no boot error overlay shown" $?
! grep -qi 'failed to start' "${OUT_DIR}/chrome-screenshot.log"; check "no startup exception in console" $?

echo
echo "artifacts:"
echo "  screenshot : ${SHOT}"
echo "  dom dump   : ${DOM}"
echo "  server     : ${URL} (still running)"

exit "${fail}"
