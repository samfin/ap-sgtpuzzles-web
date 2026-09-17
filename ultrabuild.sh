set -e
./build.sh
cd ap-sgtpuzzles
git add *
git commit -am "aaaaaaa"
git push
cd ..
git add *
git commit -am "bbbbbb"
git push
