
./build.sh
cd ap-sgtpuzzles
git add *
git commit -am "aaaaaaa"
git push

cd -

rm .git/index.lock
git add *
git commit -am "bbbbbb"
git push
