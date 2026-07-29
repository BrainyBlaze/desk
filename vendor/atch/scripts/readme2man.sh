#!/usr/bin/env bash
# readme2man.sh - Convert README.md to pandoc man page markdown (atch.1.md)
#
# Usage: bash scripts/readme2man.sh [README.md] > atch.1.md
# Then:  pandoc --standalone -t man atch.1.md -o atch.1
#
# Section mapping:
#   # atch                    -> NAME description + DESCRIPTION body
#   ## Features               -> DESCRIPTION subsection
#   ## Building               -> dropped
#   ## Usage                  -> SYNOPSIS
#   ## Commands               -> COMMANDS
#   ## Options                -> OPTIONS
#   ## Examples               -> EXAMPLES
#   ## Session storage        -> DESCRIPTION subsection
#   ## Session history        -> DESCRIPTION subsection
#   ## Backward compatibility -> COMPATIBILITY
#   ## License                -> dropped; SEE ALSO note added

set -euo pipefail

README="${1:-README.md}"
DATE=$(date +%Y-%m-%d)

# Print the body of a ## TITLE section (stops at the next # or ## heading).
h2() {
	awk -v title="$1" '
		/^```/ { fence = !fence }
		fence  { if (found) print; next }
		/^#{1,2}[[:space:]]/ {
			if (found) { exit }
			s = $0
			sub(/^#{1,2}[[:space:]]+/, "", s)
			if (tolower(s) == tolower(title)) { found=1; next }
		}
		found { print }
	' "$README"
}

# Print body of the top-level # atch section (stops at first ##).
intro() {
	awk '
		/^```/ { fence = !fence }
		fence  { if (found) print; next }
		/^#[[:space:]]/ { if (found) exit; found=1; next }
		/^##[[:space:]]/ { if (found) exit }
		found { print }
	' "$README"
}

# Print ## HEADING + body only if the section exists.
h2_section() {
	local title="$1" heading="${2:-$1}"
	local body
	body=$(h2 "$title")
	[ -n "$body" ] && printf '## %s\n\n%s\n\n' "$heading" "$body"
}

# ── header ────────────────────────────────────────────────────────────────────
echo "% atch(1) | General Commands Manual"
echo "%"
echo "% $DATE"
echo

# ── NAME ──────────────────────────────────────────────────────────────────────
echo "# NAME"
echo
echo "atch - attach and detach terminal sessions without terminal emulation"
echo

# ── SYNOPSIS ──────────────────────────────────────────────────────────────────
echo "# SYNOPSIS"
echo
h2 "Usage"
echo

# ── DESCRIPTION ───────────────────────────────────────────────────────────────
echo "# DESCRIPTION"
echo
intro
echo
h2_section "Features"
h2_section "Session history"
h2_section "Session storage"

# ── COMMANDS ──────────────────────────────────────────────────────────────────
echo "# COMMANDS"
echo
h2 "Commands"
echo

# ── OPTIONS ───────────────────────────────────────────────────────────────────
echo "# OPTIONS"
echo
h2 "Options"
echo

# ── EXAMPLES ──────────────────────────────────────────────────────────────────
echo "# EXAMPLES"
echo
h2 "Examples"
echo

# ── ENVIRONMENT ───────────────────────────────────────────────────────────────
cat <<'EOF'
# ENVIRONMENT

**ATCH_SESSION**
:   Set to the socket path of the current session inside the master's child
    process. Used to detect when a terminal is already inside a session and to
    prevent direct recursive self-attach.

**ATCH_SESSIONS**
:   Colon-delimited ancestry chain of socket paths, accumulated across nested
    sessions. Prevents indirect recursive attach (e.g. A → B → A).

**SHELL**
:   Default command when none is given on the command line.
    If unset, the login shell is read from the password database (**getpwuid**(3));
    falls back to **/bin/sh**.

EOF

# ── FILES ─────────────────────────────────────────────────────────────────────
cat <<'EOF'
# FILES

**~/.cache/atch/**
:   Default directory for session sockets and log files. Created automatically.

**/tmp/.atch-**_UID_**/**
:   Fallback socket directory when **$HOME** is unset.

_SOCKET_**.log**
:   Persistent session output log written alongside each socket.
    Replayed automatically on re-attach — whether the session is still
    running, has exited, crashed, or the machine has been rebooted.

EOF

# ── COMPATIBILITY ─────────────────────────────────────────────────────────────
echo "# COMPATIBILITY"
echo
h2 "Backward compatibility"
echo

# ── SEE ALSO ──────────────────────────────────────────────────────────────────
cat <<'EOF'
# SEE ALSO

screen(1), tmux(1)

`atch` is based on dtach by Ned T. Crigler.
EOF
