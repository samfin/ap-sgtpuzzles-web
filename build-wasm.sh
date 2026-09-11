#!/bin/sh

echo "Compiling with cmake"
cd ap-sgtpuzzles
set -e
emcmake cmake -B build-emscripten -DHTML_BUILD_MODE=archipelago .
cd build-emscripten
cmake --build .
cd ../..

echo "Copying resource files"

mkdir -p dist/res
cp -f ap-sgtpuzzles/build-emscripten/*.js dist/res
cp -f ap-sgtpuzzles/build-emscripten/*.wasm dist/res

mkdir -p dist/help
if [ -d ap-sgtpuzzles/build-emscripten/help ]; then
    cp -rf ap-sgtpuzzles/build-emscripten/help/. dist/help/
else
    echo "Warning: help/ was not built (halibut not found) -- skipping help file copy"
fi
