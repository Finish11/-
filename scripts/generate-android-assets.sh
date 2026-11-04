#!/usr/bin/env bash
# Генерирует иконки и сплэш для Android из фирменного стиля public/icon.svg.
# Нужен ImageMagick 6 (команда `convert`). Запускать вручную при смене иконки:
#   bash scripts/generate-android-assets.sh
# Готовые PNG коммитятся в android/app/src/main/res — в CI ImageMagick не требуется.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/android/app/src/main/res"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BG_FROM='#090D16'
BG_TO='#0F172A'
SPLASH_BG='#050910'
BLUE='#38BDF8'
GREEN='#10B981'

# 1. Квадратная иконка 512x512, нарисованная в 4x и уменьшенная (сглаживание).
S=4
W=$((512 * S))

convert -size ${W}x${W} gradient:"$BG_FROM"-"$BG_TO" \
  -stroke "rgba(56,189,248,0.25)" -strokewidth $((10 * S)) -fill none \
  -draw "circle $((256*S)),$((256*S)) $((256*S)),$((88*S))" \
  -stroke "rgba(56,189,248,0.45)" -strokewidth $((10 * S)) \
  -draw "circle $((256*S)),$((256*S)) $((256*S)),$((144*S))" \
  -stroke "$BLUE" -strokewidth $((24 * S)) -fill none \
  -draw "stroke-linecap round stroke-linejoin round polyline \
$((116*S)),$((264*S)) $((182*S)),$((264*S)) $((216*S)),$((176*S)) $((264*S)),$((344*S)) \
$((304*S)),$((228*S)) $((334*S)),$((264*S)) $((396*S)),$((264*S))" \
  -stroke none -fill "$GREEN" \
  -draw "circle $((384*S)),$((144*S)) $((384*S)),$((120*S))" \
  "$TMP/square-flat.png"

# Скругляем углы (rx = 120 на 512).
convert "$TMP/square-flat.png" \
  \( -size ${W}x${W} xc:none -fill white -draw "roundrectangle 0,0 $((W-1)),$((W-1)) $((120*S)),$((120*S))" \) \
  -alpha off -compose CopyOpacity -composite \
  "$TMP/icon-square.png"

# Круглая версия иконки.
convert "$TMP/square-flat.png" \
  \( -size ${W}x${W} xc:none -fill white -draw "circle $((W/2)),$((W/2)) $((W/2)),0" \) \
  -alpha off -compose CopyOpacity -composite \
  "$TMP/icon-round.png"

# 2. Раскладка по плотностям: ic_launcher.png / ic_launcher_round.png.
for entry in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  density="${entry%%:*}"
  size="${entry##*:}"
  convert "$TMP/icon-square.png" -resize "${size}x${size}" -depth 8 -strip \
    "$RES/mipmap-$density/ic_launcher.png"
  convert "$TMP/icon-round.png" -resize "${size}x${size}" -depth 8 -strip \
    "$RES/mipmap-$density/ic_launcher_round.png"
done

# 3. Adaptive foreground (108dp, глиф в безопасной зоне ~66%) — только волна и кольца.
F=4
FW=$((108 * F))
convert -size ${FW}x${FW} xc:none \
  -stroke "rgba(56,189,248,0.25)" -strokewidth $((5 * F)) -fill none \
  -draw "circle $((54*F)),$((54*F)) $((54*F)),$((18*F))" \
  -stroke "rgba(56,189,248,0.45)" -strokewidth $((5 * F)) \
  -draw "circle $((54*F)),$((54*F)) $((54*F)),$((32*F))" \
  -stroke "$BLUE" -strokewidth $((10 * F)) -fill none \
  -draw "stroke-linecap round stroke-linejoin round polyline \
$((15*F)),$((56*F)) $((30*F)),$((56*F)) $((37*F)),$((37*F)) $((47*F)),$((73*F)) \
$((55*F)),$((48*F)) $((61*F)),$((56*F)) $((75*F)),$((56*F))" \
  "$TMP/foreground-108.png"

for entry in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
  density="${entry%%:*}"
  size="${entry##*:}"
  convert "$TMP/foreground-108.png" -background none -resize "${size}x${size}" -depth 8 -strip \
    "$RES/mipmap-$density/ic_launcher_foreground.png"
done

# 4. Сплэш: тёмный фон + логотип по центру, размеры как в шаблоне Capacitor.
splash() {
  local file="$1" w="$2" h="$3"
  local logo
  logo=$(awk -v w="$w" -v h="$h" 'BEGIN { m = (w < h ? w : h); printf "%d", m * 0.34 }')
  convert -size "${w}x${h}" "xc:$SPLASH_BG" \
    \( "$TMP/icon-square.png" -resize "${logo}x${logo}" \) \
    -gravity center -composite -depth 8 -strip "$file"
}

splash "$RES/drawable/splash.png" 480 320
splash "$RES/drawable-land-mdpi/splash.png" 480 320
splash "$RES/drawable-land-hdpi/splash.png" 800 480
splash "$RES/drawable-land-xhdpi/splash.png" 1280 720
splash "$RES/drawable-land-xxhdpi/splash.png" 1600 960
splash "$RES/drawable-land-xxxhdpi/splash.png" 1920 1280
splash "$RES/drawable-port-mdpi/splash.png" 320 480
splash "$RES/drawable-port-hdpi/splash.png" 480 800
splash "$RES/drawable-port-xhdpi/splash.png" 720 1280
splash "$RES/drawable-port-xxhdpi/splash.png" 960 1600
splash "$RES/drawable-port-xxxhdpi/splash.png" 1280 1920

echo "Готово: иконки и сплэш обновлены в android/app/src/main/res"
