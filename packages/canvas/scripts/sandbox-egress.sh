# Sourced by deploy-sandbox.sh; a function and nothing else, so a test can source it too.
#
# `sbx egress <name> allow` only ADDS to a sandbox's own allow-list, so a host removed from
# sandbox/workspace.env would stay reachable on a sandbox that already exists. This is the other half:
# given the allow-list workspace.env declares ($1, space separated) and the output of `sbx egress <name>` on
# stdin, it prints, one per line, the sandbox's own additions that the declaration no longer lists, which the
# deploy then removes. Only lines sbx marks "(this sandbox only)" are the sandbox's own: the site-wide list
# is the site's and is never touched here.
stale_egress() {
  local declared=" $1 " host
  sed -n 's/^  \(.*\)   (this sandbox only)$/\1/p' | while IFS= read -r host; do
    case "$declared" in
      *" $host "*) ;;
      *) printf '%s\n' "$host" ;;
    esac
  done
}
