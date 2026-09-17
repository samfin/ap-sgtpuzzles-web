#!/bin/sh

echo "Compiling with cmake"
cd ap-sgtpuzzles
set -e
rm -f CMakeCache.txt
# NOTE: -DHTML_BUILD_MODE=archipelago selects emcc-ap.c/emccpre-ap.js
# instead of the plain emcc.c/emccpre.js. This is required: the plain
# variant relies on location.hash to load a specific puzzle, which
# nothing in this client ever sets, so it can't load a puzzle by seed/id
# at all. The archipelago variant instead reads the puzzleId global
# (set by static/puzzleframe.js from the "?i=" query param) into argv.
# Without this flag explicitly set, the build only happens to come out
# right if build-emscripten/CMakeCache.txt already has it cached from a
# previous configure -- a fresh checkout or a wiped build dir would
# silently produce the wrong (non-seedable) client.
emcmake cmake -B build-emscripten -DPUZZLES_ENABLE_UNFINISHED=group -DHTML_BUILD_MODE=archipelago .
cd build-emscripten
cmake --build .
cd ../..

echo "Copying resource files"

mkdir -p dist/res
cp -f ap-sgtpuzzles/build-emscripten/*.js dist/res
cp -f ap-sgtpuzzles/build-emscripten/*.wasm dist/res
cp -f ap-sgtpuzzles/build-emscripten/unfinished/*.js dist/res
cp -f ap-sgtpuzzles/build-emscripten/unfinished/*.wasm dist/res
cp -f ap-sgtpuzzles/build-emscripten/xsheep-puzzles/*.js dist/res
cp -f ap-sgtpuzzles/build-emscripten/xsheep-puzzles/*.wasm dist/res

mkdir -p dist/help
cp -rf ap-sgtpuzzles/build-emscripten/help/. dist/help/