# Helpers for driving the app in the desktop container (xdotool).
export DISPLAY=:99
win() { for i in $(seq 1 40); do W=$(xdotool search --name "^Lord of the Rows$" 2>/dev/null | tail -1); [ -n "$W" ] && break; sleep 0.5; done; sleep 1.5
  xdotool windowactivate --sync $W; xdotool windowmove --sync $W 0 0; xdotool windowsize --sync $W 1600 970; sleep 1; }
click() { xdotool mousemove $1 $2; sleep 0.15; xdotool click 1; sleep ${3:-0.6}; }
dbl() { xdotool mousemove $1 $2; sleep 0.15; xdotool click --repeat 2 --delay 90 1; sleep ${3:-0.8}; }
typeat() { click $1 $2 0.2; xdotool key ctrl+a; xdotool type --delay 12 "$3"; }
shot() { import -window root /tmp/$1.png; }
