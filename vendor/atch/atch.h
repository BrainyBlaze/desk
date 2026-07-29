#ifndef atch_h
#define atch_h

#if defined(__has_attribute)
#if __has_attribute(unused)
#define ATTRIBUTE_UNUSED __attribute__((__unused__))
#else
#define ATTRIBUTE_UNUSED
#endif
#elif defined(__GNUC__) || defined(__clang__)
#define ATTRIBUTE_UNUSED __attribute__((__unused__))
#else
#define ATTRIBUTE_UNUSED
#endif

#include "config.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#ifdef HAVE_PTY_H
#include <pty.h>
#endif

#ifdef HAVE_UTIL_H
#include <util.h>
#endif

#ifdef HAVE_LIBUTIL_H
#include <libutil.h>
#endif

#ifdef HAVE_STROPTS_H
#include <stropts.h>
#endif

#ifdef HAVE_UNISTD_H
#include <unistd.h>
#endif

#ifdef HAVE_SYS_IOCTL_H
#include <sys/ioctl.h>
#endif

#ifdef HAVE_SYS_RESOURCE_H
#include <sys/resource.h>
#endif

#include <pwd.h>
#include <termios.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <dirent.h>

#ifndef S_ISREG
#define S_ISREG(m) (((m) & S_IFMT) == S_IFREG)
#endif

#ifndef S_ISSOCK
#define S_ISSOCK(m) (((m) & S_IFMT) == S_IFSOCK)
#endif

extern char *progname, *sockname;
extern int detach_char, no_suspend, redraw_method, clear_method, no_ansiterm, quiet;
extern const char *child_stderr_path;
extern const char *child_se_preload;
extern const char *tstate_events_path;
extern size_t log_max_size;
extern struct termios orig_term;
extern int dont_have_tty;
extern time_t session_start;
void format_age(time_t secs, char *buf, size_t size);
void session_age(char *buf, size_t size);
const char *session_shortname(void);

enum
{
	MSG_PUSH	= 0,
	MSG_ATTACH	= 1,
	MSG_DETACH	= 2,
	MSG_WINCH	= 3,
	MSG_REDRAW	= 4,
	MSG_KILL	= 5,
};

enum
{
	REDRAW_UNSPEC	= 0,
	REDRAW_NONE	= 1,
	REDRAW_CTRL_L	= 2,
	REDRAW_WINCH	= 3,
};

enum
{
	CLEAR_UNSPEC	= 0,
	CLEAR_NONE	= 1,
	CLEAR_MOVE	= 2,
};

/*
** Buffer used for the text stream from master back to clients, and for the
** keystroke stream from clients to master. Also defines the maximum payload
** of MSG_PUSH.
*/
#define BUFSIZE 4096

/* The client to master protocol.
**
** BrainyBlaze fork: extended payload from sizeof(struct winsize) (8 B) to
** BUFSIZE (4096 B) and `len` from uint8_t to uint16_t. Stock atch sends
** MSG_PUSH in 8-byte chunks, which is chatty for multi-KB prompts. With
** the wider payload, MSG_PUSH carries up to BUFSIZE bytes per packet,
** matching how the master writes back to the pty. Wire-incompatible with
** stock atch — clients and master must come from the same build.
*/
struct packet
{
	unsigned char type;
	uint16_t len;
	union
	{
		unsigned char buf[BUFSIZE];
		struct winsize ws;
	} u;
};

/* Computed at startup from progname so the binary can be renamed freely. */
extern const char *session_envvar;
#define SESSION_ENVVAR session_envvar

void write_buf_or_fail(int fd, const void *buf, size_t count);
void write_packet_or_fail(int fd, const struct packet *pkt);

void get_session_dir(char *buf, size_t size);
int socket_with_chdir(char *path, int (*fn)(char *));

int replay_session_log(int saved_errno);
int attach_main(int noerror);
int master_main(char **argv, int waitattach, int dontfork);
int push_main(void);
int rm_main(int all);
int list_main(int show_all);
int kill_main(int force);

char const * clear_csi_data(void);

/* tstate.c: terminal mode-state tracker. */
void tstate_reset(void);
void tstate_scan(const unsigned char *buf, size_t len);
size_t tstate_emit_preamble(unsigned char *out, size_t outlen);

/* Title-based busy/idle inference + readiness signal + OSC 8 links.
**
** Both codex and claude write the current state into the window title
** via OSC 0 (\x1b]0;<text>\x07). Convention: a leading UTF-8 braille
** code point (U+2800..U+28FF) followed by a space indicates the agent
** is working ("busy"); any other prefix (including "✳ " for claude
** and bare project text for codex) is idle. `tstate_scan` records
** title changes; `tstate_is_busy` returns -1 (no title seen yet), 0
** (idle), or 1 (busy). `tstate_set_state_callback` installs a hook
** invoked on every busy<->idle transition.
**
** `tstate_set_ready_callback` installs a one-shot hook fired on the
** first XTVERSION query (ESC [ > [N] q) from the child — TUIs emit
** this at the very end of init, so it is the cleanest "REPL is up"
** signal we can passively observe.
**
** `tstate_set_link_callback` installs a hook fired on every OSC 8
** hyperlink OPEN (ESC ] 8 ; <params> ; <URI> ST with non-empty URI).
** `uri` is the link target. Params are opaque to us. Closes (empty
** URI) are silent terminators.
**
** master.c uses all three callbacks to append `ready` / `state` /
** `link` events to a consumer-supplied ndjson file (atch -T <path>).
*/
int tstate_is_busy(void);
const char *tstate_get_title(void);
void tstate_set_state_callback(void (*cb)(int busy));
void tstate_set_ready_callback(void (*cb)(void));
void tstate_set_link_callback(void (*cb)(const char *uri));

#ifdef sun
#define BROKEN_MASTER
#endif
#endif
