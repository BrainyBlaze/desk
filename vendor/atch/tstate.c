#include "atch.h"

/*
** Terminal mode-state tracker (DECSET / kitty-kbd / OSC title).
**
** Master scans every byte that flows from the pty to clients via
** tstate_scan(), recording the last-seen state per mode number AND
** the last seen window title (OSC 0).
**
** On reattach, master calls tstate_emit_preamble() to materialize the
** current snapshot as a CSI byte sequence that re-applies any non-default
** modes the application enabled at startup. This restores mouse,
** alt-screen, bracketed paste, focus events, and kitty kbd protocol on
** clients that never saw the original DECSET emission.
**
** Title tracking infers a busy/idle state for the running agent CLI:
**   - codex prefixes the title with a braille spinner glyph while
**     working (U+2800..U+28FF range), then writes the bare project
**     name once it goes idle.
**   - claude does the same with braille for busy and U+2733 (✳) for
**     idle.
** Convention: a UTF-8 braille code point at the start of an OSC 0
** payload means busy; anything else means idle. A state-change
** callback (installed by master.c) fires on every busy<->idle
** transition.
**
** Ready detection: the first XTVERSION query (ESC [ > [N] q) from
** the child means the TUI is past splash and accepting input. A
** one-shot ready callback fires the moment we see it.
**
** Scope (intentionally minimal):
**   - DECSET / DECRST  ESC [ ? N [ ; N ]* ( h | l )
**   - kitty kbd push   ESC [ > N u
**   - kitty kbd pop    ESC [ < u
**   - XTVERSION query  ESC [ > [N] q  (one-shot ready signal)
**   - OSC 0 title      ESC ] 0 ; <payload> ( BEL | ESC \ )
**
** Limitations:
**   - The scanner is per-byte stateless: a sequence split across two
**     reads is missed. In practice apps emit each CSI/OSC in one
**     write(), and titles re-emit on every state tick.
**   - We only track modes from the built-in list. Unknown modes are
**     ignored — extending the list takes one line in builtin_modes[].
*/

#define MAX_MODES 32
#define TITLE_MAX 256

struct tstate_mode {
	int mode;		/* DEC private mode number */
	int default_on;		/* 1 if 'h' is default, 0 if 'l' */
	int state;		/* -1 = unseen, 0 = 'l', 1 = 'h' */
};

static struct tstate_mode modes[MAX_MODES];
static int nmodes;

/* Kitty kbd protocol state: top-of-stack flags, -1 if never seen. */
static int kitty_kbd_state = -1;

/* OSC 0 title state. -1 until first title seen. */
static int title_busy = -1;
static char last_title[TITLE_MAX];
static void (*state_cb)(int busy);

/* Ready signal: fires on first XTVERSION query from the child. */
static int xtversion_seen;
static void (*ready_cb)(void);

/* OSC 8 hyperlink callback: fires on every link OPEN
** (`ESC ] 8 ; <params> ; <URI> ST` with non-empty URI). Closes
** (`ESC ] 8 ; ; ST`) are mere terminators and do not fire. */
static void (*link_cb)(const char *uri);

static const struct {
	int mode;
	int default_on;
} builtin_modes[] = {
	{ 1,    0 }, /* application cursor keys */
	{ 7,    1 }, /* auto-wrap */
	{ 12,   0 }, /* cursor blink */
	{ 25,   1 }, /* cursor visibility */
	{ 1000, 0 }, /* mouse: button events */
	{ 1002, 0 }, /* mouse: button + drag */
	{ 1003, 0 }, /* mouse: any-event */
	{ 1004, 0 }, /* focus events */
	{ 1005, 0 }, /* mouse: utf-8 */
	{ 1006, 0 }, /* mouse: SGR */
	{ 1015, 0 }, /* mouse: urxvt */
	{ 1016, 0 }, /* mouse: SGR-pixels */
	{ 1047, 0 }, /* alternate screen (no save) */
	{ 1048, 0 }, /* save cursor */
	{ 1049, 0 }, /* alt screen + save cursor */
	{ 2004, 0 }, /* bracketed paste */
};

#define NBUILTINS (sizeof(builtin_modes) / sizeof(builtin_modes[0]))

static void init_defaults(void)
{
	size_t i;

	if (nmodes > 0)
		return;
	for (i = 0; i < NBUILTINS && nmodes < MAX_MODES; i++) {
		modes[nmodes].mode = builtin_modes[i].mode;
		modes[nmodes].default_on = builtin_modes[i].default_on;
		modes[nmodes].state = -1;
		nmodes++;
	}
}

static struct tstate_mode *find_mode(int mode)
{
	int i;

	for (i = 0; i < nmodes; i++)
		if (modes[i].mode == mode)
			return &modes[i];
	return NULL;
}

void tstate_reset(void)
{
	nmodes = 0;
	kitty_kbd_state = -1;
	title_busy = -1;
	last_title[0] = '\0';
	xtversion_seen = 0;
	init_defaults();
}

int tstate_is_busy(void)
{
	return title_busy;
}

const char *tstate_get_title(void)
{
	return last_title;
}

void tstate_set_state_callback(void (*cb)(int busy))
{
	state_cb = cb;
}

void tstate_set_ready_callback(void (*cb)(void))
{
	ready_cb = cb;
}

void tstate_set_link_callback(void (*cb)(const char *uri))
{
	link_cb = cb;
}

/* Apply a DECSET/DECRST mode change. */
static void apply_mode(int mode_num, int new_state)
{
	struct tstate_mode *m = find_mode(mode_num);

	if (m)
		m->state = new_state;
}

/* Scan one CSI body of form `?N[;N]*X` where X is 'h'/'l'.
** `body` points just after `?`; `body_len` excludes the final letter.
** `final` is 'h' or 'l'. */
static void scan_decset(const unsigned char *body, size_t body_len, char final)
{
	size_t j = 0;
	int new_state = (final == 'h') ? 1 : 0;

	while (j < body_len) {
		int mode_num = 0;
		int saw_digit = 0;

		while (j < body_len && body[j] >= '0' && body[j] <= '9') {
			mode_num = mode_num * 10 + (body[j] - '0');
			j++;
			saw_digit = 1;
		}
		if (saw_digit)
			apply_mode(mode_num, new_state);
		if (j < body_len && body[j] == ';')
			j++;
		else
			break;
	}
}

/* Scan one CSI body of form `>N u` (kitty kbd push) or `<u` (pop). */
static void scan_kitty(const unsigned char *body, size_t body_len, char prefix)
{
	if (prefix == '>') {
		int flags = 0;
		size_t j = 0;
		while (j < body_len && body[j] >= '0' && body[j] <= '9') {
			flags = flags * 10 + (body[j] - '0');
			j++;
		}
		kitty_kbd_state = flags;
	} else if (prefix == '<') {
		/* pop: we don't keep a real stack, just clear */
		kitty_kbd_state = -1;
	}
}

/* OSC 0 payload handler. payload may not be NUL-terminated; plen is
** the byte count between `;` and the terminator (BEL or ESC\). Detect
** busy via a leading UTF-8 braille code point: U+2800..U+28FF maps to
** 0xE2 0xA0..0xA3 0x80..0xBF. We require a space after the spinner
** glyph to avoid false positives on payloads that happen to start
** with those bytes (codex/claude both emit "<braille> <name>"). */
static void handle_osc_title(const unsigned char *payload, size_t plen)
{
	size_t copy;
	int busy;

	copy = plen < sizeof(last_title) - 1 ? plen : sizeof(last_title) - 1;
	memcpy(last_title, payload, copy);
	last_title[copy] = '\0';

	busy = (plen >= 4 &&
		payload[0] == 0xE2 &&
		payload[1] >= 0xA0 && payload[1] <= 0xA3 &&
		payload[2] >= 0x80 && payload[2] <= 0xBF &&
		payload[3] == ' ') ? 1 : 0;

	if (busy != title_busy) {
		title_busy = busy;
		if (state_cb)
			state_cb(busy);
	}
}

/* OSC 8 payload handler. Format inside the payload: `params;URI` where
** params is opaque to us (we don't parse) and URI is the link target.
** Empty URI = close, ignored. Bounded buffer; oversize URIs truncate. */
#define LINK_URI_MAX 1024

static void handle_osc_link(const unsigned char *payload, size_t plen)
{
	char uri[LINK_URI_MAX];
	size_t semi, uri_len;

	for (semi = 0; semi < plen; semi++)
		if (payload[semi] == ';')
			break;
	if (semi >= plen)
		return; /* malformed: no `;` between params and URI */

	uri_len = plen - semi - 1;
	if (uri_len == 0)
		return; /* close (no URI) — terminator, no event */
	if (uri_len >= sizeof(uri))
		uri_len = sizeof(uri) - 1;
	memcpy(uri, payload + semi + 1, uri_len);
	uri[uri_len] = '\0';

	if (link_cb)
		link_cb(uri);
}

/* Try to consume an OSC sequence starting at buf[start] (which is ESC).
** Returns the index of the first byte after the terminator on success,
** start+1 if it's not actually an OSC we recognise, or 0 if the OSC is
** truncated at the tail of buf (caller should break). */
static size_t scan_osc(const unsigned char *buf, size_t len, size_t start)
{
	size_t i, payload_start;
	int cmd;

	/* Need at least ESC ] 0 ; X TERM = 6 bytes for the shortest match. */
	if (start + 3 >= len)
		return 0; /* truncated */
	if (buf[start + 1] != ']')
		return start + 1;

	/* Parse OSC command number (digits before ';'). */
	cmd = 0;
	i = start + 2;
	if (i >= len)
		return 0;
	if (buf[i] < '0' || buf[i] > '9')
		return start + 1; /* not numeric — skip */
	while (i < len && buf[i] >= '0' && buf[i] <= '9') {
		cmd = cmd * 10 + (buf[i] - '0');
		i++;
	}
	if (i >= len)
		return 0;
	if (buf[i] != ';')
		return start + 1; /* malformed — skip past ESC */
	payload_start = ++i;

	/* Find terminator: BEL (0x07) or ST (ESC \). Cap search at the pty
	** read buffer size to avoid runaway scans on garbled streams. OSC 8
	** URIs can easily exceed the OSC 0 title cap (TITLE_MAX*2 = 512). */
	while (i < len && i - payload_start < BUFSIZE) {
		unsigned char c = buf[i];
		if (c == 0x07) {
			if (cmd == 0)
				handle_osc_title(buf + payload_start,
						 i - payload_start);
			else if (cmd == 8)
				handle_osc_link(buf + payload_start,
						i - payload_start);
			return i + 1;
		}
		if (c == 0x1b) {
			if (i + 1 >= len)
				return 0; /* truncated */
			if (buf[i + 1] == '\\') {
				if (cmd == 0)
					handle_osc_title(buf + payload_start,
							 i - payload_start);
				else if (cmd == 8)
					handle_osc_link(buf + payload_start,
							i - payload_start);
				return i + 2;
			}
			/* embedded ESC that is not ST — payload abort */
			return i;
		}
		i++;
	}
	/* No terminator found within our limit: if we're at end of buffer,
	** treat as truncated and let the caller re-try on next read. */
	if (i >= len)
		return 0;
	return i; /* overflowed cap — give up on this OSC */
}

void tstate_scan(const unsigned char *buf, size_t len)
{
	size_t i = 0;

	init_defaults();

	while (i < len) {
		size_t body_start;
		char prefix = 0, final;

		if (buf[i] != 0x1b) {
			i++;
			continue;
		}
		if (i + 1 >= len)
			break; /* truncated ESC */

		/* OSC: ESC ] */
		if (buf[i + 1] == ']') {
			size_t next = scan_osc(buf, len, i);
			if (next == 0)
				break; /* truncated */
			i = next;
			continue;
		}

		/* CSI: ESC [ */
		if (buf[i + 1] != '[') {
			i++;
			continue;
		}
		if (i + 2 >= len)
			break;
		body_start = i + 2;

		if (body_start < len &&
		    (buf[body_start] == '?' || buf[body_start] == '>' ||
		     buf[body_start] == '<')) {
			prefix = buf[body_start];
			body_start++;
		}

		/* Scan parameter bytes 0x30-0x3F and intermediate 0x20-0x2F
		** until a final byte 0x40-0x7E. */
		{
			size_t j = body_start;
			while (j < len) {
				unsigned char c = buf[j];
				if (c >= 0x40 && c <= 0x7E)
					break;
				if (c < 0x20 || c > 0x3F) {
					/* not a CSI param/intermediate;
					** abort this match. */
					break;
				}
				j++;
			}
			if (j >= len) {
				/* incomplete at tail */
				break;
			}
			final = buf[j];
			if (final >= 0x40 && final <= 0x7E) {
				if (prefix == '?' &&
				    (final == 'h' || final == 'l'))
					scan_decset(buf + body_start,
					            j - body_start, final);
				else if ((prefix == '>' || prefix == '<') &&
				         final == 'u')
					scan_kitty(buf + body_start,
					           j - body_start, prefix);
				else if (prefix == '>' && final == 'q') {
					/* XTVERSION query — TUI is past
					** splash and ready to accept input. */
					if (!xtversion_seen) {
						xtversion_seen = 1;
						if (ready_cb)
							ready_cb();
					}
				}
				i = j + 1;
				continue;
			}
			i = i + 1;
		}
	}
}

/* Materialize the current state snapshot into `out`, in CSI bytes.
** Only modes whose state diverges from default are emitted.
** Returns bytes written, or 0 if nothing to emit / buffer too small. */
size_t tstate_emit_preamble(unsigned char *out, size_t outlen)
{
	size_t pos = 0;
	int i;

	init_defaults();

	for (i = 0; i < nmodes; i++) {
		int n;
		if (modes[i].state < 0)
			continue;
		if (modes[i].state == modes[i].default_on)
			continue;
		n = snprintf((char *)out + pos, outlen - pos,
		             "\033[?%d%c", modes[i].mode,
		             modes[i].state ? 'h' : 'l');
		if (n < 0 || pos + (size_t)n >= outlen)
			return 0;
		pos += (size_t)n;
	}

	if (kitty_kbd_state > 0) {
		int n = snprintf((char *)out + pos, outlen - pos,
		                 "\033[>%du", kitty_kbd_state);
		if (n > 0 && pos + (size_t)n < outlen)
			pos += (size_t)n;
	}

	return pos;
}
