#define HAVE_LIBUTIL 1
#ifdef __APPLE__
#define HAVE_UTIL_H 1
#else
#define HAVE_PTY_H 1
#endif

#define HAVE_SYS_IOCTL_H 1
#define HAVE_SYS_RESOURCE_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_UNISTD_H 1

#define PACKAGE_NAME "atch"
#ifndef PACKAGE_VERSION
#define PACKAGE_VERSION "1.6-bb1"
#endif
#define PACKAGE_URL "https://github.com/BrainyBlaze/atch"
#define RETSIGTYPE void

/* Guard env var consumed by sanitize_env.so's LD_PRELOAD shim to enable the
** in-memory payload overwrite. When `-S <path>` is given to atch start/new,
** master.c setenv()s both LD_PRELOAD=<path> and this var in the forked child
** before execve, so neither value appears in atch's /proc/<pid>/cmdline. */
#define SE_GUARD_VAR "_SE_8db1c501b6390c36e98bb7e52268733b"


/* In-memory scrollback ring buffer size — must be a power of two */
#ifndef SCROLLBACK_SIZE
#define SCROLLBACK_SIZE (128 * 1024)
#endif

/* Maximum size of the on-disk session log; older bytes are trimmed on open */
#ifndef LOG_MAX_SIZE
#define LOG_MAX_SIZE (1024 * 1024)
#endif
