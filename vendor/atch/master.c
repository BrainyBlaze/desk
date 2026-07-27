#include "atch.h"
#include "atch_storage.h"
#include "atch_wire_v3.h"

#include <limits.h>

static int open_session_sink(const char *path, int flags, mode_t mode)
{
	char root[PATH_MAX];
	const char *slash = strrchr(sockname, '/');
	if (!slash || (size_t)(slash - sockname) >= sizeof(root)) {
		errno = EINVAL;
		return -1;
	}
	memcpy(root, sockname, (size_t)(slash - sockname));
	root[slash - sockname] = '\0';
	return atch_storage_open_sink(root, path, flags, mode);
}

/* The pty struct - The pty information is stored here. */
struct pty {
	/* File descriptor of the pty */
	int fd;
#ifdef BROKEN_MASTER
	/* File descriptor of the slave side of the pty. For broken systems. */
	int slave;
#endif
	/* Process id of the child. */
	pid_t pid;
	/* The terminal parameters of the pty. Old and new for comparision
	 ** purposes. */
	struct termios term;
	/* The current window size of the pty. */
	struct winsize ws;
};
static struct pty the_pty;
static uint32_t v3_master_generation = 1;

static void load_v3_generation(void)
{
	const char *value = getenv("ATCH_GENERATION");
	char *end;
	unsigned long parsed;

	if (!value || !*value)
		return;
	errno = 0;
	parsed = strtoul(value, &end, 10);
	if (errno == 0 && *end == '\0' && parsed > 0 && parsed <= UINT32_MAX)
		v3_master_generation = (uint32_t)parsed;
}

/* A connected client */
struct client {
	/* The next client in the linked list. */
	struct client *next;
	/* The previous client in the linked list. */
	struct client **pprev;
	/* File descriptor of the client. */
	int fd;
	/* Whether or not the client is attached. */
	int attached;
	/* Scrollback replay state: physical ring index and bytes remaining. */
	size_t replay_head;
	size_t replay_remaining;
	int v3;
	unsigned char *v3_rx;
	size_t v3_rx_cap;
	size_t v3_rx_len;
	int v3_hello;
	uint32_t v3_caps;
	uint32_t v3_generation;
	uint64_t v3_record_seq;
	uint64_t v3_output_offset;
	atch_v3_reassembler v3_reassembler;
};

enum {
	V3_HELLO = 1, V3_ATTACH = 2, V3_ATTACH_ACK = 3, V3_INPUT = 18,
	V3_RESIZE = 21, V3_OUTPUT = 16
};

static void client_drop(struct client *p)
{
	close(p->fd);
	if (p->next)
		p->next->pprev = p->pprev;
	*(p->pprev) = p->next;
	atch_v3_reassembler_free(&p->v3_reassembler);
	free(p->v3_rx);
	free(p);
}

static void v3_send(struct client *p, uint16_t type, uint32_t generation,
	uint64_t sequence, const unsigned char *payload, size_t length)
{
	unsigned char frame[ATCH_V3_HEADER_LEN + ATCH_V3_MAX_PAYLOAD];
	size_t header;

	if (length > ATCH_V3_MAX_PAYLOAD)
		return;
	header = atch_v3_encode_header(frame, sizeof(frame), type, 0,
		generation, sequence, 0, (uint32_t)length);
	if (!header)
		return;
	memcpy(frame + header, payload, length);
	write_buf_or_fail(p->fd, frame, header + length);
}

static int v3_dispatch(struct client *p, const atch_v3_frame *f)
{
	atch_v3_hello hello;
	atch_v3_attach attach;
	char session[ATCH_V3_MAX_STR16 + 1];
	unsigned char ack[106];
	size_t i;

	if (f->type == V3_HELLO) {
		if (p->v3_hello || atch_v3_decode_hello(f->payload, f->payload_length, &hello))
			return -1;
		p->v3_hello = 1;
		p->v3_caps = hello.capabilities;
		return 0;
	}
	if (f->type == V3_ATTACH) {
		if (!p->v3_hello || atch_v3_decode_attach(f->payload, f->payload_length,
			&attach, session, sizeof(session)))
			return -1;
		p->v3_generation = v3_master_generation;
		p->v3_record_seq = attach.last_seen_record_seq;
		p->v3_output_offset = attach.last_seen_offset;
		the_pty.ws.ws_row = attach.rows;
		the_pty.ws.ws_col = attach.cols;
		if (ioctl(the_pty.fd, TIOCSWINSZ, &the_pty.ws) < 0)
			return -1;
		/* ATTACH_ACK follows the pinned wire trace layout: retained range,
		 * controller acknowledgement, checkpoint/tail state, geometry, caps. */
		memset(ack, 0, sizeof(ack));
		ack[0] = (unsigned char)p->v3_generation;
		ack[1] = (unsigned char)(p->v3_generation >> 8);
		ack[2] = (unsigned char)(p->v3_generation >> 16);
		ack[3] = (unsigned char)(p->v3_generation >> 24);
		for (i = 0; i < 8; ++i) {
			ack[20 + i] = (unsigned char)(p->v3_output_offset >> (8 * i));
			ack[28 + i] = (unsigned char)(p->v3_record_seq >> (8 * i));
			ack[36 + i] = (unsigned char)(p->v3_output_offset >> (8 * i));
			ack[44 + i] = (unsigned char)(p->v3_record_seq >> (8 * i));
			ack[77 + i] = (unsigned char)(p->v3_output_offset >> (8 * i));
			ack[85 + i] = (unsigned char)(p->v3_record_seq >> (8 * i));
		}
		ack[93] = (unsigned char)attach.rows; ack[94] = (unsigned char)(attach.rows >> 8);
		ack[95] = (unsigned char)attach.cols; ack[96] = (unsigned char)(attach.cols >> 8);
		ack[97] = ack[98] = ack[99] = ack[100] = 1;
		ack[102] = (unsigned char)p->v3_caps; ack[103] = (unsigned char)(p->v3_caps >> 8);
		ack[104] = (unsigned char)(p->v3_caps >> 16); ack[105] = (unsigned char)(p->v3_caps >> 24);
		p->attached = 1;
		v3_send(p, V3_ATTACH_ACK, p->v3_generation, 0, ack, sizeof(ack));
		return 0;
	}
	if (f->generation != p->v3_generation || !p->attached)
		return -1;
	if (f->type == V3_INPUT) {
		uint32_t length;
		if (f->payload_length < 9)
			return -1;
		length = (uint32_t)f->payload[5] | ((uint32_t)f->payload[6] << 8) |
			((uint32_t)f->payload[7] << 16) | ((uint32_t)f->payload[8] << 24);
		if (length > f->payload_length - 9 || length != f->payload_length - 9)
			return -1;
		if (length)
			write_buf_or_fail(the_pty.fd, f->payload + 9, length);
		return 0;
	}
	if (f->type == V3_RESIZE) {
		uint32_t generation;
		if (f->payload_length != 16)
			return -1;
		generation = (uint32_t)f->payload[8] | ((uint32_t)f->payload[9] << 8) |
			((uint32_t)f->payload[10] << 16) | ((uint32_t)f->payload[11] << 24);
		if (generation != p->v3_generation)
			return -1;
		the_pty.ws.ws_row = (unsigned short)(f->payload[12] | (f->payload[13] << 8));
		the_pty.ws.ws_col = (unsigned short)(f->payload[14] | (f->payload[15] << 8));
		if (atch_v3_validate_geometry(the_pty.ws.ws_row, the_pty.ws.ws_col))
			return -1;
		return ioctl(the_pty.fd, TIOCSWINSZ, &the_pty.ws) < 0 ? -1 : 0;
	}
	return -1;
}

static int client_activity_v3(struct client *p)
{
	unsigned char buf[8192];
	ssize_t n;

	n = read(p->fd, buf, sizeof(buf));
	if (n < 0 && (errno == EAGAIN || errno == EINTR)) return 0;
	if (n <= 0 || p->v3_rx_len + (size_t)n > ATCH_V3_MAX_MSG) return -1;
	if (p->v3_rx_len + (size_t)n > p->v3_rx_cap) {
		size_t cap = p->v3_rx_cap ? p->v3_rx_cap : 4096;
		while (cap < p->v3_rx_len + (size_t)n) cap *= 2;
		p->v3_rx = realloc(p->v3_rx, cap);
		if (!p->v3_rx) return -1;
		p->v3_rx_cap = cap;
	}
	memcpy(p->v3_rx + p->v3_rx_len, buf, (size_t)n);
	p->v3_rx_len += (size_t)n;
	while (p->v3_rx_len >= ATCH_V3_HEADER_LEN) {
		atch_v3_frame f;
		uint32_t len = (uint32_t)p->v3_rx[12] | ((uint32_t)p->v3_rx[13] << 8) |
			((uint32_t)p->v3_rx[14] << 16) | ((uint32_t)p->v3_rx[15] << 24);
		size_t total = ATCH_V3_HEADER_LEN + (size_t)len;
		int rc;
		if (len > ATCH_V3_MAX_PAYLOAD || total > p->v3_rx_len) break;
		rc = atch_v3_reassembler_push_at(&p->v3_reassembler, p->v3_rx, total, 0, &f);
		if (rc == ATCH_V3_TRUNCATED && p->v3_reassembler.active) {
			memmove(p->v3_rx, p->v3_rx + total, p->v3_rx_len - total);
			p->v3_rx_len -= total;
			continue;
		}
		if (rc || v3_dispatch(p, &f)) return -1;
		memmove(p->v3_rx, p->v3_rx + total, p->v3_rx_len - total);
		p->v3_rx_len -= total;
	}
	return 0;
}

/* The list of connected clients. */
static struct client *clients;
/* The pseudo-terminal created for the child process. */

/* Kitty version we masquerade as. Drives both XTVERSION_RESP and the
** TERM_PROGRAM_VERSION env we inject into the child. Bump in lock-step
** if you decide to mirror a newer kitty release (and update DA2's
** 4000/47 too — they encode the same major/minor). */
#define KITTY_MASQ_VERSION "0.47.0"

/* Persistent session log */
static int log_fd = -1;
static size_t log_written;
static time_t master_start_time;
size_t log_max_size = LOG_MAX_SIZE;

/* ndjson event sink (opened from tstate_events_path; -1 = disabled). */
static int tstate_events_fd = -1;
/* Captured exit code, written into the final `exit` event. Set by code
** paths that know their exit code; defaults to 0 for signal-driven and
** atexit-only paths. */
static int master_exit_code;

/* Scrollback ring buffer */
static unsigned char scrollback_buf[SCROLLBACK_SIZE];
static size_t scrollback_head;	/* physical index of the oldest byte */
static size_t scrollback_len;	/* number of valid bytes, 0..SCROLLBACK_SIZE */

/*
** Trim log_fd to its last LOG_MAX_SIZE bytes, then seek to the end.
** Called at startup and whenever log_written reaches LOG_MAX_SIZE.
*/
static void rotate_log(void)
{
	off_t size;
	char *buf;
	ssize_t n;

	size = lseek(log_fd, 0, SEEK_END);
	if (size > (off_t) log_max_size) {
		buf = malloc(log_max_size);
		if (buf) {
			lseek(log_fd, size - (off_t) log_max_size, SEEK_SET);
			n = read(log_fd, buf, log_max_size);
			if (n > 0) {
				ftruncate(log_fd, 0);
				lseek(log_fd, 0, SEEK_SET);
				write(log_fd, buf, (size_t)n);
			}
			free(buf);
		}
	}
	lseek(log_fd, 0, SEEK_END);
}

/*
** Open (or create) the session log, trimming it to LOG_MAX_SIZE if it has
** grown larger. Returns the fd positioned at the end, ready for appending.
*/
static int open_log(const char *path)
{
	int fd;

	fd = atch_storage_open_path_file(path, O_RDWR | O_CREAT, 0600);
	if (fd < 0)
		return -1;

	log_fd = fd;
	rotate_log();
	return fd;
}

/* JSON-escape `src` into `dst`. Handles ", \, and control chars (<0x20)
** which would break ndjson line framing. UTF-8 high bytes are passed
** through unchanged. Returns bytes written; never overflows dstlen. */
static size_t json_escape(const char *src, size_t srclen,
			  char *dst, size_t dstlen)
{
	size_t i, o = 0;

	for (i = 0; i < srclen; i++) {
		unsigned char c = (unsigned char)src[i];
		if (c == '"' || c == '\\') {
			if (o + 2 >= dstlen)
				break;
			dst[o++] = '\\';
			dst[o++] = (char)c;
		} else if (c < 0x20) {
			int n;
			if (o + 6 >= dstlen)
				break;
			n = snprintf(dst + o, dstlen - o, "\\u%04x", c);
			if (n < 0 || (size_t)n >= dstlen - o)
				break;
			o += (size_t)n;
		} else {
			if (o + 1 >= dstlen)
				break;
			dst[o++] = (char)c;
		}
	}
	return o;
}

/* Append one ndjson event to tstate_events_fd, prefixed with a ts field.
** `body` is the JSON fragment that follows the ts (no leading comma, no
** outer braces). Best-effort: write failures are swallowed so a missing
** consumer can never stall the multiplexer. */
static void emit_event(const char *body)
{
	char line[2048];
	struct timespec ts;
	int n;
	ssize_t w;

	if (tstate_events_fd < 0)
		return;
	clock_gettime(CLOCK_REALTIME, &ts);
	n = snprintf(line, sizeof(line),
		     "{\"ts\":%lld.%03ld,%s}\n",
		     (long long)ts.tv_sec, ts.tv_nsec / 1000000L, body);
	if (n < 0)
		return;
	if ((size_t)n >= sizeof(line))
		n = (int)sizeof(line) - 1;
	w = write(tstate_events_fd, line, (size_t)n);
	(void)w;
}

static void emit_ready(void)
{
	emit_event("\"type\":\"ready\"");
}

static void emit_state(int busy)
{
	const char *title = tstate_get_title();
	/* tstate caps title at 256 bytes; json_escape grows worst-case 6x
	** on control chars but for realistic UTF-8 titles it's ~1x. The
	** 1024/1100 sizes leave comfortable headroom; if a pathological
	** title would still overflow, json_escape truncates safely. */
	char esc[1024];
	char body[1100];
	size_t elen;
	int n;

	elen = json_escape(title, strlen(title), esc, sizeof(esc) - 1);
	esc[elen] = '\0';
	n = snprintf(body, sizeof(body),
		     "\"type\":\"state\",\"state\":\"%s\",\"title\":\"%s\"",
		     busy ? "busy" : "idle", esc);
	if (n < 0)
		return;
	emit_event(body);
}

static void emit_exit(int code)
{
	char body[64];
	int n = snprintf(body, sizeof(body),
			 "\"type\":\"exit\",\"code\":%d", code);
	if (n < 0)
		return;
	emit_event(body);
}

/* Emit one `link` event for an OSC 8 hyperlink open. URI is tstate-
** bounded at 1024 bytes, so the body fits in emit_event's 2 KB line. */
static void emit_link(const char *uri)
{
	char esc_uri[1024];
	char body[1200];
	size_t ulen;
	int n;

	ulen = json_escape(uri, strlen(uri), esc_uri, sizeof(esc_uri) - 1);
	esc_uri[ulen] = '\0';

	n = snprintf(body, sizeof(body),
		     "\"type\":\"link\",\"uri\":\"%s\"", esc_uri);
	if (n < 0)
		return;
	emit_event(body);
}

/* Write end marker to log, emit final `exit` event, close fds, and
** unlink the socket. */
static void cleanup_session(void)
{
	if (log_fd >= 0) {
		time_t age = time(NULL) - master_start_time;
		char agebuf[32];
		char marker[160];

		format_age(age, agebuf, sizeof(agebuf));
		snprintf(marker, sizeof(marker),
			 "\r\n[%s: session '%s' ended after %s]\r\n", progname,
			 session_shortname(), agebuf);
		write(log_fd, marker, strlen(marker));
		close(log_fd);
		log_fd = -1;
	}
	if (tstate_events_fd >= 0) {
		emit_exit(master_exit_code);
		close(tstate_events_fd);
		tstate_events_fd = -1;
	}
	unlink(sockname);
}

/* Signal */
static RETSIGTYPE master_die(int sig)
{
	/* Well, the child died. */
	if (sig == SIGCHLD) {
#ifdef BROKEN_MASTER
		/* Damn you Solaris! */
		close(the_pty.fd);
#endif
		return;
	}
	master_exit_code = 1;
	exit(1);
}

/* Sets a file descriptor to non-blocking mode. */
static int setnonblocking(int fd)
{
	int flags;

#if defined(O_NONBLOCK)
	flags = fcntl(fd, F_GETFL);
	if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
		return -1;
	return 0;
#elif defined(FIONBIO)
	flags = 1;
	if (ioctl(fd, FIONBIO, &flags) < 0)
		return -1;
	return 0;
#else
#warning Do not know how to set non-blocking mode.
	return 0;
#endif
}

/* Initialize the pty structure. */
static int init_pty(char **argv, int statusfd)
{
	/* Use the original terminal's settings. We don't have to set the
	 ** window size here, because the attacher will send it in a packet. */
	the_pty.term = orig_term;
	memset(&the_pty.ws, 0, sizeof(struct winsize));

	/* Create the pty process */
	if (!dont_have_tty)
		the_pty.pid = forkpty(&the_pty.fd, NULL, &the_pty.term, NULL);
	else
		the_pty.pid = forkpty(&the_pty.fd, NULL, NULL, NULL);
	if (the_pty.pid < 0)
		return -1;
	else if (the_pty.pid == 0) {
		/* Child.. Execute the program. */
		/* If -2 <path> was set, redirect fd 2 to that file/fifo so the
		 ** child's stderr does not mix with TUI bytes on the pty. */
		if (child_stderr_path) {
			int errfd = open_session_sink(child_stderr_path,
					 O_WRONLY | O_CREAT | O_APPEND, 0600);
			if (errfd >= 0) {
				dup2(errfd, 2);
				if (errfd != 2)
					close(errfd);
			}
		}
		/* SESSION_ENVVAR holds the colon-separated ancestry chain,
		 ** outermost first, ending with the current session's socket.
		 ** A single (non-nested) session has no colon. */
		{
			const char *prev = getenv(SESSION_ENVVAR);
			if (prev && *prev) {
				size_t len =
				    strlen(prev) + 1 + strlen(sockname) + 1;
				char *chain = malloc(len);
				if (chain) {
					snprintf(chain, len, "%s:%s", prev,
						 sockname);
					setenv(SESSION_ENVVAR, chain, 1);
					free(chain);
				}
			} else {
				setenv(SESSION_ENVVAR, sockname, 1);
			}
		}
		/* Caps masquerade env: our XTVERSION/DA replies mirror kitty,
		** but many TUIs (Claude Code via supports-hyperlinks, bat,
		** eza, delta, …) gate OSC 8 hyperlinks on TERM_PROGRAM /
		** LC_TERMINAL alone — the wire-level caps are never read.
		** Identify ourselves as kitty in those env channels too.
		** Only set if unset, so a real upstream terminal (iTerm,
		** vscode, …) keeps its identity for tools that do env-honest
		** detection. LC_TERMINAL survives tmux's TERM_PROGRAM rewrite. */
		if (!getenv("TERM_PROGRAM")) {
			setenv("TERM_PROGRAM", "kitty", 1);
			setenv("TERM_PROGRAM_VERSION", KITTY_MASQ_VERSION, 1);
		}
		if (!getenv("LC_TERMINAL"))
			setenv("LC_TERMINAL", "kitty", 1);
		/* If -S <path> was given, introduce the sanitize_env.so
		 ** LD_PRELOAD and its guard var in THIS forked child only,
		 ** right before execve. Keeps both values out of atch master's
		 ** argv/environ — /proc/<atch>/cmdline never shows them. */
		if (child_se_preload) {
			setenv("LD_PRELOAD", child_se_preload, 1);
			setenv(SE_GUARD_VAR, "1", 1);
		}
		execvp(*argv, argv);

		/* Report the error to statusfd if we can, or stdout if we
		 ** can't. */
		if (statusfd != -1)
			dup2(statusfd, 1);
		else
			printf("%s", clear_csi_data());

		printf("%s: could not execute %s: %s\r\n", progname,
		       *argv, strerror(errno));
		fflush(stdout);
		_exit(127);
	}
	/* Parent.. Finish up and return */
#ifdef BROKEN_MASTER
	{
		char *buf;

		buf = ptsname(the_pty.fd);
		the_pty.slave = open(buf, O_RDWR | O_NOCTTY);
	}
#endif
	return 0;
}

/* Send a signal to the slave side of a pseudo-terminal. */
static void killpty(struct pty *pty, int sig)
{
	pid_t pgrp = -1;

#ifdef TIOCSIGNAL
	if (ioctl(pty->fd, TIOCSIGNAL, sig) >= 0)
		return;
#endif
#ifdef TIOCSIG
	if (ioctl(pty->fd, TIOCSIG, sig) >= 0)
		return;
#endif
#ifdef TIOCGPGRP
#ifdef BROKEN_MASTER
	if (ioctl(pty->slave, TIOCGPGRP, &pgrp) >= 0 && pgrp != -1 &&
	    kill(-pgrp, sig) >= 0)
		return;
#endif
	if (ioctl(pty->fd, TIOCGPGRP, &pgrp) >= 0 && pgrp != -1 &&
	    kill(-pgrp, sig) >= 0)
		return;
#endif

	/* Fallback using the child's pid. */
	kill(-pty->pid, sig);
}

/* Creates a new unix domain socket. */
static int create_socket(char *name)
{
	int s;
	struct sockaddr_un sockun;
	mode_t omask;

	if (strlen(name) > sizeof(sockun.sun_path) - 1)
		return socket_with_chdir(name, create_socket);

	omask = umask(077);
	s = socket(PF_UNIX, SOCK_STREAM, 0);
	umask(omask);		/* umask always succeeds, errno is untouched. */
	if (s < 0)
		return -1;
	sockun.sun_family = AF_UNIX;
	memcpy(sockun.sun_path, name, strlen(name) + 1);
	if (bind(s, (struct sockaddr *)&sockun, sizeof(sockun)) < 0) {
		close(s);
		return -1;
	}
	if (listen(s, 128) < 0) {
		close(s);
		return -1;
	}
	if (setnonblocking(s) < 0) {
		close(s);
		return -1;
	}
	/* chmod it to prevent any surprises */
	if (chmod(name, 0600) < 0) {
		close(s);
		return -1;
	}
	return s;
}

/* Update the modes on the socket. */
static void update_socket_modes(int exec)
{
	struct stat st;
	mode_t newmode;

	if (stat(sockname, &st) < 0)
		return;

	if (exec)
		newmode = st.st_mode | S_IXUSR;
	else
		newmode = st.st_mode & ~S_IXUSR;

	if (st.st_mode != newmode)
		chmod(sockname, newmode);
}

/* Append len bytes from buf to the scrollback ring buffer.
** If the buffer is full, the oldest bytes are overwritten. */
static void scrollback_append(const unsigned char *buf, size_t len)
{
	size_t i;

	if (len == 0)
		return;
	if (len >= SCROLLBACK_SIZE) {
		buf += len - SCROLLBACK_SIZE;
		len = SCROLLBACK_SIZE;
	}
	for (i = 0; i < len; i++) {
		size_t wp =
		    (scrollback_head + scrollback_len) & (SCROLLBACK_SIZE - 1);
		scrollback_buf[wp] = buf[i];
		if (scrollback_len < SCROLLBACK_SIZE) {
			scrollback_len++;
		} else {
			scrollback_head =
			    (scrollback_head + 1) & (SCROLLBACK_SIZE - 1);
		}
	}
}

/* Drain pending scrollback data to client p's non-blocking socket.
** Sets p->attached = 1 when replay is complete. */
static void replay_drain(struct client *p)
{
	while (p->replay_remaining > 0) {
		size_t contiguous = SCROLLBACK_SIZE - p->replay_head;
		ssize_t n;

		if (contiguous > p->replay_remaining)
			contiguous = p->replay_remaining;

		n = write(p->fd, scrollback_buf + p->replay_head, contiguous);

		if (n < 0) {
			if (errno == EINTR)
				continue;
			if (errno == EAGAIN)
				return;
			/* Write error: remove this client */
			close(p->fd);
			if (p->next)
				p->next->pprev = p->pprev;
			*(p->pprev) = p->next;
			free(p);
			return;
		}
		p->replay_head =
		    (p->replay_head + (size_t)n) & (SCROLLBACK_SIZE - 1);
		p->replay_remaining -= (size_t)n;
	}
	p->attached = 1;
}

/* Stock atch starts ring-replay here on MSG_ATTACH.
** BrainyBlaze fork: replaced by tstate_emit_preamble in MSG_ATTACH handler.
** The function is retained but never called; kept for diff hygiene. */
static void ATTRIBUTE_UNUSED replay_start(struct client *p)
{
	if (scrollback_len == 0) {
		p->replay_remaining = 0;
		p->attached = 1;
		return;
	}
	p->replay_head = scrollback_head;
	p->replay_remaining = scrollback_len;
	replay_drain(p);
}

/* Auto-respond to terminal capability queries the child emits on the pty.
**
** Many TUIs (Ink, htop, vim) probe the terminal via Primary/Secondary Device
** Attributes (CSI c / CSI >c) and XTVERSION (CSI >q). Atch is a passive
** multiplexer — no terminal sits behind it, so these queries normally time
** out and the TUI falls back to conservative caps. Here we recognise the
** four common probes and write a canned xterm-class response back through
** the master pty fd (which is the child's stdin). Opt out by setting
** ATCH_NO_TERM_AUTORESPONSE in atch start's env.
**
** Implemented as plain substring matching on the chunk: queries are short
** (3-4 bytes) and almost always arrive intact within one read; if a query
** ever straddles a chunk boundary the child re-issues on its own timeout.
*/
static void respond_term_caps(const unsigned char *buf, size_t len)
{
	static int initialised = 0;
	static int disabled = 0;
	if (!initialised) {
		const char *env = getenv("ATCH_NO_TERM_AUTORESPONSE");
		disabled = (env && env[0] && env[0] != '0');
		initialised = 1;
	}
	if (disabled || len < 3)
		return;

	/* Slide a window of size `qlen` over buf and memcmp. */
	struct probe {
		const char *q;
		size_t qlen;
		const char *r;
		size_t rlen;
	};
	/* Caps preamble mirrors kitty 0.47.0 byte-for-byte
	** (kitty/screen.c report_device_attributes + screen_xtversion,
	** kitty/window.py da1, kitty/constants.py version).
	** PRIMARY_VERSION = major + 4000 = 4000; SECONDARY_VERSION = minor = 47.
	** sizeof() includes the trailing NUL, matching the established probe
	** convention. KITTY_MASQ_VERSION is shared with the env-var
	** injection in init_pty so TUIs see a consistent identity on both
	** the wire-cap and env-probe channels. */
#define KITTY_DA1_RESP "\x1b[?62;52;c"
#define KITTY_DA2_RESP "\x1b[>1;4000;47c"
#define KITTY_XTVERSION_RESP "\x1bP>|kitty(" KITTY_MASQ_VERSION ")\x1b\\"
	static const struct probe probes[] = {
		/* DA1: VT220 + write-clipboard (kitty default opts). */
		{ "\x1b[c", 3, KITTY_DA1_RESP, sizeof(KITTY_DA1_RESP) },
		/* DA2: terminal type 1 (VT220) + primary 4000 + secondary 47. */
		{ "\x1b[>c", 4, KITTY_DA2_RESP, sizeof(KITTY_DA2_RESP) },
		/* XTVERSION (no param). */
		{ "\x1b[>q", 4, KITTY_XTVERSION_RESP, sizeof(KITTY_XTVERSION_RESP) },
		/* XTVERSION (param 0). */
		{ "\x1b[>0q", 5, KITTY_XTVERSION_RESP, sizeof(KITTY_XTVERSION_RESP) },
		{ NULL, 0, NULL, 0 },
	};
	for (size_t i = 0; i + 2 < len; i++) {
		if (buf[i] != 0x1b || buf[i + 1] != '[')
			continue;
		for (int p = 0; probes[p].q; p++) {
			if (i + probes[p].qlen > len)
				continue;
			if (memcmp(buf + i, probes[p].q, probes[p].qlen) == 0) {
				ssize_t n = write(the_pty.fd, probes[p].r,
						  probes[p].rlen);
				(void)n;
				break;
			}
		}
	}
}

/* Process activity on the pty - Input and terminal changes are sent out to
** the attached clients. If the pty goes away, we die. */
static void pty_activity(int s)
{
	unsigned char buf[BUFSIZE];
	ssize_t len;
	struct client *p, *next;
	fd_set readfds, writefds;
	int highest_fd, nclients;

	/* Read the pty activity */
	len = read(the_pty.fd, buf, sizeof(buf));
	if (len > 0)
		respond_term_caps(buf, (size_t)len);

	/* Error -> die */
	if (len <= 0) {
		int status;

		if (wait(&status) >= 0) {
			if (WIFEXITED(status)) {
				master_exit_code = WEXITSTATUS(status);
				exit(master_exit_code);
			}
		}
		master_exit_code = 1;
		exit(1);
	}
	scrollback_append(buf, (size_t)len);
	/* v3 clients receive the same PTY bytes as RECORD(OUTPUT) envelopes. */
	{
		struct client *vp;
		for (vp = clients; vp; vp = vp->next) {
			unsigned char inner[ATCH_V3_MAX_PAYLOAD], frame[ATCH_V3_HEADER_LEN + ATCH_V3_MAX_PAYLOAD];
			size_t n, h;
			if (!vp->v3 || !vp->attached)
				continue;
			if ((size_t)len > sizeof(inner) - 33)
				continue;
			++vp->v3_record_seq;
			/* The envelope and its RECORD(OUTPUT) body share this sequence. */
			h = 0;
			inner[h++] = 1;
			for (n = 0; n < 8; n++) inner[h++] = (unsigned char)(vp->v3_record_seq >> (8*n));
			inner[h++] = (unsigned char)vp->v3_generation; inner[h++] = (unsigned char)(vp->v3_generation >> 8);
			inner[h++] = (unsigned char)(vp->v3_generation >> 16); inner[h++] = (unsigned char)(vp->v3_generation >> 24);
			for (n = 0; n < 8; n++) inner[h++] = (unsigned char)(vp->v3_output_offset >> (8*n));
			inner[h++] = (unsigned char)len; inner[h++] = (unsigned char)(len >> 8);
			inner[h++] = (unsigned char)(len >> 16); inner[h++] = (unsigned char)(len >> 24);
			memcpy(inner + h, buf, (size_t)len); h += (size_t)len;
			{ uint32_t crc = atch_v3_crc32(inner, h); for (n = 0; n < 4; n++) inner[h++] = (unsigned char)(crc >> (8*n)); }
			n = atch_v3_encode_header(frame, sizeof(frame), V3_OUTPUT, 0, vp->v3_generation, vp->v3_record_seq, 0, (uint32_t)h);
			memcpy(frame + n, inner, h); write_buf_or_fail(vp->fd, frame, n + h);
			vp->v3_output_offset += (uint64_t)len;
		}
	}
	tstate_scan(buf, (size_t)len);
	if (log_fd >= 0) {
		write(log_fd, buf, (size_t)len);
		log_written += (size_t)len;
		if (log_written >= log_max_size) {
			rotate_log();
			log_written = 0;
		}
	}
#ifdef BROKEN_MASTER
	/* Get the current terminal settings. */
	if (tcgetattr(the_pty.slave, &the_pty.term) < 0) {
		master_exit_code = 1;
		exit(1);
	}
#else
	/* Get the current terminal settings. */
	if (tcgetattr(the_pty.fd, &the_pty.term) < 0) {
		master_exit_code = 1;
		exit(1);
	}
#endif

 top:
	/*
	 ** Wait until at least one client is writable. Also wait on the control
	 ** socket in case a new client tries to connect.
	 */
	FD_ZERO(&readfds);
	FD_ZERO(&writefds);
	FD_SET(s, &readfds);
	highest_fd = s;
	for (p = clients, nclients = 0; p; p = p->next) {
		if (!p->attached)
			continue;
		FD_SET(p->fd, &writefds);
		if (p->fd > highest_fd)
			highest_fd = p->fd;
		nclients++;
	}
	if (nclients == 0)
		return;
	if (select(highest_fd + 1, &readfds, &writefds, NULL, NULL) < 0)
		return;

	/* Send the data out to the clients. */
	for (p = clients, nclients = 0; p; p = next) {
		ssize_t written;

		next = p->next;
		if (!FD_ISSET(p->fd, &writefds))
			continue;
		/* v3 clients receive framed OUTPUT records in the branch above. */
		if (p->v3) {
			nclients++;
			continue;
		}

		written = 0;
		while (written < len) {
			ssize_t n = write(p->fd, buf + written, len - written);

			if (n > 0) {
				written += n;
				continue;
			} else if (n < 0 && errno == EINTR)
				continue;
			break;
		}
		if (written == len) {
			nclients++;
		} else if (errno != EAGAIN) {
			/* Write error: drop this client */
			close(p->fd);
			if (next)
				next->pprev = p->pprev;
			*(p->pprev) = next;
			free(p);
		}
	}

	/* Try again if nothing happened. */
	if (!FD_ISSET(s, &readfds) && nclients == 0)
		goto top;
}

/* Process activity on the control socket */
static void control_activity(int s)
{
	int fd;
	struct client *p;

	/* Accept the new client and link it in. */
	fd = accept(s, NULL, NULL);
	if (fd < 0)
		return;
	/* Defence in depth: every client fd is later placed in an fd_set, and
	** FD_SET on a descriptor >= FD_SETSIZE writes past the bitmap. Refuse
	** the connection instead of corrupting the stack. */
	else if (fd >= FD_SETSIZE) {
		close(fd);
		return;
	}
	else if (setnonblocking(fd) < 0) {
		close(fd);
		return;
	}

	/* Link it in. */
	p = malloc(sizeof(struct client));
	if (!p) {
		close(fd);
		return;
	}
	p->fd = fd;
	p->attached = 0;
	p->replay_head = 0;
	p->replay_remaining = 0;
	p->v3 = 0;
	p->v3_rx = NULL;
	p->v3_rx_cap = p->v3_rx_len = 0;
	p->v3_hello = 0;
	p->v3_caps = p->v3_generation = 0;
	p->v3_record_seq = p->v3_output_offset = 0;
	atch_v3_reassembler_init(&p->v3_reassembler);
	p->pprev = &clients;
	p->next = *(p->pprev);
	if (p->next)
		p->next->pprev = &p->next;
	*(p->pprev) = p;
}

/* Process activity from a client. */
static void client_activity(struct client *p)
{
	ssize_t len;
	struct packet pkt;
	unsigned char magic[4];

	if (!p->v3) {
		len = recv(p->fd, magic, sizeof(magic), MSG_PEEK);
		/* Nothing readable yet: keep waiting for the magic. */
		if (len < 0 && (errno == EAGAIN || errno == EINTR))
			return;
		/* Any other receive error is fatal for this client. */
		if (len < 0) {
			client_drop(p);
			return;
		}
		/* EOF. The peer connected and closed without sending the magic
		** (a liveness probe does exactly this). Dropping here is what
		** keeps the accepted fd from leaking: a closed socket stays
		** readable forever, so returning would re-enter this function
		** on every select() and never release the descriptor. Leaked
		** fds accumulated until the fd_set overran and the master
		** aborted, which surfaced as sessions dying about a minute
		** after boot. */
		if (len == 0) {
			client_drop(p);
			return;
		}
		/* 1..3 bytes: a partial magic is legitimate; wait for the rest. */
		if (len < (ssize_t)sizeof(magic))
			return;
		if (!memcmp(magic, "ATV3", 4))
			p->v3 = 1;
	}
	if (p->v3) {
		if (client_activity_v3(p) < 0)
			client_drop(p);
		return;
	}

	/* Read the activity. */
	len = read(p->fd, &pkt, sizeof(struct packet));
	if (len < 0 && (errno == EAGAIN || errno == EINTR))
		return;

	/* Close the client on an error. */
	if (len != sizeof(struct packet)) {
		client_drop(p);
		return;
	}

	/* Push out data to the program. */
	if (pkt.type == MSG_PUSH) {
		if (pkt.len <= sizeof(pkt.u.buf))
			write_buf_or_fail(the_pty.fd, pkt.u.buf, pkt.len);
	}

	/* Attach or detach from the program.
	**
	** BrainyBlaze fork: zero-replay. Instead of dumping the 128 KiB
	** scrollback ring (which corrupts terminal mode state for rich CLIs),
	** we emit a DECSET preamble reflecting the live mode-state snapshot
	** and let the application redraw cells via the SIGWINCH wiggle that
	** REDRAW_WINCH triggers separately.
	*/
	else if (pkt.type == MSG_ATTACH) {
		unsigned char preamble[1024];
		size_t plen;

		(void)pkt.len;
		plen = tstate_emit_preamble(preamble, sizeof(preamble));
		if (plen > 0)
			write_buf_or_fail(p->fd, preamble, plen);
		p->attached = 1;
	} else if (pkt.type == MSG_DETACH)
		p->attached = 0;

	/* Window size change request, without a forced redraw. */
	else if (pkt.type == MSG_WINCH) {
		the_pty.ws = pkt.u.ws;
		ioctl(the_pty.fd, TIOCSWINSZ, &the_pty.ws);
	}

	/* Force a redraw using a particular method. */
	else if (pkt.type == MSG_REDRAW) {
		int method = pkt.len;

		/* If the client didn't specify a particular method, use
		 ** whatever we had on startup. */
		if (method == REDRAW_UNSPEC)
			method = redraw_method;
		if (method == REDRAW_NONE)
			return;

		/* Set the window size. */
		the_pty.ws = pkt.u.ws;
		ioctl(the_pty.fd, TIOCSWINSZ, &the_pty.ws);

		/* Send a ^L character if the terminal is in no-echo and
		 ** character-at-a-time mode. */
		if (method == REDRAW_CTRL_L) {
			char c = '\f';

			if (((the_pty.term.c_lflag & (ECHO | ICANON)) == 0) &&
			    (the_pty.term.c_cc[VMIN] == 1)) {
				write_buf_or_fail(the_pty.fd, &c, 1);
			}
		}
		/* Send a WINCH signal to the program. */
		else if (method == REDRAW_WINCH) {
			killpty(&the_pty, SIGWINCH);
		}
	}

	/* Send a signal to the child process. */
	else if (pkt.type == MSG_KILL) {
		int sig = pkt.len ? (int)(unsigned char)pkt.len : SIGTERM;
		killpty(&the_pty, sig);
	}
}

/* The master process - It watches over the pty process and the attached */
/* clients. */
static void master_process(int s, char **argv, int waitattach, int statusfd)
{
	struct client *p, *next;
	fd_set readfds;
	fd_set writefds;
	int highest_fd;
	int nullfd;

	int has_attached_client = 0;

	/* Okay, disassociate ourselves from the original terminal, as we
	 ** don't care what happens to it. */
	setsid();

	/* Set a trap to write the end marker and unlink the socket when we die. */
	atexit(cleanup_session);

	/* Create a pty in which the process is running. */
	signal(SIGCHLD, master_die);
	if (init_pty(argv, statusfd) < 0) {
		if (statusfd != -1)
			dup2(statusfd, 1);
		if (errno == ENOENT)
			printf("%s: Could not find a pty.\n", progname);
		else
			printf("%s: init_pty: %s\n", progname, strerror(errno));
		master_exit_code = 1;
		exit(1);
	}

	/* Set up some signals. */
	signal(SIGPIPE, SIG_IGN);
	signal(SIGXFSZ, SIG_IGN);
	signal(SIGHUP, SIG_IGN);
	signal(SIGTTIN, SIG_IGN);
	signal(SIGTTOU, SIG_IGN);
	signal(SIGINT, master_die);
	signal(SIGTERM, master_die);

	/* Close statusfd, since we don't need it anymore. */
	if (statusfd != -1)
		close(statusfd);

	/* Make sure stdin/stdout/stderr point to /dev/null. We are now a
	 ** daemon. */
	nullfd = open("/dev/null", O_RDWR);
	dup2(nullfd, 0);
	dup2(nullfd, 1);
	dup2(nullfd, 2);
	if (nullfd > 2)
		close(nullfd);

	/* Loop forever. */
	while (1) {
		int new_has_attached_client = 0;

		/* Re-initialize the file descriptor sets for select. */
		FD_ZERO(&readfds);
		FD_ZERO(&writefds);
		FD_SET(s, &readfds);
		highest_fd = s;

		/*
		 ** When waitattach is set, wait until the client attaches
		 ** before trying to read from the pty.
		 */
		if (waitattach) {
			if (clients && clients->attached)
				waitattach = 0;
		} else {
			FD_SET(the_pty.fd, &readfds);
			if (the_pty.fd > highest_fd)
				highest_fd = the_pty.fd;
		}

		for (p = clients; p; p = p->next) {
			FD_SET(p->fd, &readfds);
			if (p->fd > highest_fd)
				highest_fd = p->fd;

			if (p->attached)
				new_has_attached_client = 1;

			if (p->replay_remaining > 0) {
				FD_SET(p->fd, &writefds);
				if (p->fd > highest_fd)
					highest_fd = p->fd;
			}
		}

		/* chmod the socket if necessary. */
		if (has_attached_client != new_has_attached_client) {
			update_socket_modes(new_has_attached_client);
			has_attached_client = new_has_attached_client;
		}

		/* Wait for something to happen. */
		if (select(highest_fd + 1, &readfds, &writefds, NULL, NULL) < 0) {
			if (errno == EINTR || errno == EAGAIN)
				continue;
			master_exit_code = 1;
			exit(1);
		}

		/* New client? */
		if (FD_ISSET(s, &readfds))
			control_activity(s);
		/* Activity on a client? */
		for (p = clients; p; p = next) {
			next = p->next;
			if (FD_ISSET(p->fd, &readfds))
				client_activity(p);
		}
		/* Drain pending scrollback replay for writable clients. */
		for (p = clients; p; p = next) {
			next = p->next;
			if (p->replay_remaining > 0
			    && FD_ISSET(p->fd, &writefds))
				replay_drain(p);
		}
		/* pty activity? */
		if (FD_ISSET(the_pty.fd, &readfds))
			pty_activity(s);
	}
}

int master_main(char **argv, int waitattach, int dontfork)
{
	int fd[2] = { -1, -1 };
	int s;
	pid_t pid;

	load_v3_generation();

	/* Use a default redraw method if one hasn't been specified yet. */
	if (redraw_method == REDRAW_UNSPEC)
		redraw_method = dont_have_tty ? REDRAW_NONE : REDRAW_WINCH;

	/* Create the unix domain socket. */
	s = create_socket(sockname);
	if (s < 0) {
		if (errno == EADDRINUSE)
			printf("%s: session '%s' is already running\n",
			       progname, session_shortname());
		else
			printf("%s: %s: %s\n", progname, sockname,
			       strerror(errno));
		return 1;
	}

	/* Open the persistent session log (best-effort; ignore failures). */
	if (log_max_size > 0) {
		char log_path[600];

		snprintf(log_path, sizeof(log_path), "%s.log", sockname);
		log_fd = open_log(log_path);
	}
	master_start_time = time(NULL);
	tstate_reset();

	/* Open the consumer-supplied ndjson event sink, if any. Done before
	** the fork so a bad path is reported to the caller's stderr (fast
	** fail). O_NONBLOCK is harmless on regular files and prevents a
	** hang if the consumer accidentally supplied a FIFO with no reader.
	** FD_CLOEXEC ensures the agent child does not inherit this fd. */
	if (tstate_events_path) {
		tstate_events_fd = open_session_sink(tstate_events_path,
					O_WRONLY | O_APPEND | O_NONBLOCK, 0600);
		if (tstate_events_fd < 0) {
			printf("%s: -T %s: %s\n", progname,
			       tstate_events_path, strerror(errno));
			close(s);
			unlink(sockname);
			if (log_fd >= 0) {
				close(log_fd);
				log_fd = -1;
			}
			return 1;
		}
#if defined(F_SETFD) && defined(FD_CLOEXEC)
		fcntl(tstate_events_fd, F_SETFD, FD_CLOEXEC);
#endif
		tstate_set_state_callback(emit_state);
		tstate_set_ready_callback(emit_ready);
		tstate_set_link_callback(emit_link);
	}
#if defined(F_SETFD) && defined(FD_CLOEXEC)
	fcntl(s, F_SETFD, FD_CLOEXEC);

	/* If FD_CLOEXEC works, create a pipe and use it to report any errors
	 ** that occur while trying to execute the program. */
	if (dontfork) {
		fd[1] = dup(2);
		if (fcntl(fd[1], F_SETFD, FD_CLOEXEC) < 0) {
			close(fd[1]);
			fd[1] = -1;
		}
	} else if (pipe(fd) >= 0) {
		if (fcntl(fd[0], F_SETFD, FD_CLOEXEC) < 0 ||
		    fcntl(fd[1], F_SETFD, FD_CLOEXEC) < 0) {
			close(fd[0]);
			close(fd[1]);
			fd[0] = fd[1] = -1;
		}
	}
#endif

	if (dontfork) {
		master_process(s, argv, waitattach, fd[1]);
		return 0;
	}

	/* Fork off so we can daemonize and such */
	pid = fork();
	if (pid < 0) {
		printf("%s: fork: %s\n", progname, strerror(errno));
		cleanup_session();
		return 1;
	} else if (pid == 0) {
		/* Child - this becomes the master */
		if (fd[0] != -1)
			close(fd[0]);
		master_process(s, argv, waitattach, fd[1]);
		return 0;
	}
	/* Parent - just return. */

#if defined(F_SETFD) && defined(FD_CLOEXEC)
	/* Check if an error occurred while trying to execute the program. */
	if (fd[0] != -1) {
		char buf[1024];
		ssize_t len;

		close(fd[1]);
		len = read(fd[0], buf, sizeof(buf));
		if (len > 0) {
			do {
				write_buf_or_fail(2, buf, len);
				len = read(fd[0], buf, sizeof(buf));
			} while (len > 0);

			kill(pid, SIGTERM);
			return 1;
		}
		close(fd[0]);
	}
#endif
	close(s);
	return 0;
}

#ifndef HAVE_PTY_H
/* openpty: Use /dev/ptmx and Unix98 if we have it. */
int
openpty(int *amaster, int *aslave, char *name, struct termios *termp,
	struct winsize *winp)
{
	int master, slave;
	char *buf;

	master = open("/dev/ptmx", O_RDWR);
	if (master < 0)
		return -1;
	if (grantpt(master) < 0)
		return -1;
	if (unlockpt(master) < 0)
		return -1;
	buf = ptsname(master);
	if (!buf)
		return -1;

	slave = open(buf, O_RDWR | O_NOCTTY);
	if (slave < 0)
		return -1;

#ifdef I_PUSH
	if (ioctl(slave, I_PUSH, "ptem") < 0)
		return -1;
	if (ioctl(slave, I_PUSH, "ldterm") < 0)
		return -1;
#endif

	*amaster = master;
	*aslave = slave;
	if (name)
		strcpy(name, buf);
	if (termp)
		tcsetattr(slave, TCSAFLUSH, termp);
	if (winp)
		ioctl(slave, TIOCSWINSZ, winp);
	return 0;
}

pid_t
forkpty(int *amaster, char *name, struct termios *termp, struct winsize *winp)
{
	pid_t pid;
	int master, slave;

	if (openpty(&master, &slave, name, termp, winp) < 0)
		return -1;
	*amaster = master;

	/* Fork off... */
	pid = fork();
	if (pid < 0)
		return -1;
	else if (pid == 0) {
		setsid();
#ifdef TIOCSCTTY
		if (ioctl(slave, TIOCSCTTY, NULL) < 0)
			_exit(1);
#else
		{
			char *buf = ptsname(master);
			int fd = open(buf, O_RDWR);
			close(fd);
		}
#endif
		dup2(slave, 0);
		dup2(slave, 1);
		dup2(slave, 2);

		if (slave > 2)
			close(slave);
		close(master);
		return 0;
	} else {
		close(slave);
		return pid;
	}
}
#endif				/* !HAVE_PTY_H */
