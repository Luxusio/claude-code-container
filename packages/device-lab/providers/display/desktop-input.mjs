export { desktopPointValid, desktopDragValid } from "../domain/desktop-control-transfer.mjs";

export const X11_DRAG_COMMAND = String.raw`set -eu
x1=$1; y1=$2; x2=$3; y2=$4; duration=$5
read -r width height < <(xdotool getdisplaygeometry)
(( x1 < width && x2 < width && y1 < height && y2 < height )) || { echo 'drag-outside-display' >&2; exit 1; }
xdotool mousemove --sync "$x1" "$y1"
trap 'xdotool mouseup 1' EXIT
trap 'exit 1' TERM INT HUP
xdotool mousedown 1
steps=20
pause=$(awk -v ms="$duration" 'BEGIN { printf "%.6f", ms / 20000 }')
for ((i=1; i<=steps; i++)); do
  sleep "$pause"
  xdotool mousemove --sync "$((x1 + (x2-x1)*i/steps))" "$((y1 + (y2-y1)*i/steps))"
done`;
