#!/bin/bash
# Поднять версию приложения одинаково в index.html и sw.js:  bash scripts/bump-version.sh 1.9.0
# (без этого у пользователей не появится «Доступна новая версия»)
set -e
cd "$(dirname "$0")/.."
V="$1"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Использование: bash scripts/bump-version.sh X.Y.Z  (сейчас: $(grep -o "APP_VERSION = '[^']*'" index.html))"; exit 1; }
sed -i "s/const APP_VERSION = '[^']*';/const APP_VERSION = '$V';/" index.html
sed -i "s/const VERSION = 'traty-v[^']*';/const VERSION = 'traty-v$V';/" sw.js
grep -n "APP_VERSION = " index.html; grep -n "const VERSION" sw.js
