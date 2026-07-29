#define _GNU_SOURCE
#include "atch_storage.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <signal.h>
#include <unistd.h>

#ifndef PID_MAX
#define PID_MAX 4194304L
#endif

static size_t limit_for(enum atch_alloc_kind kind)
{
	static const size_t limits[] = {ATCH_MAX_PAYLOAD, ATCH_MAX_GEOMETRY,
		ATCH_MAX_CELL, ATCH_MAX_PARSER, ATCH_MAX_REASSEMBLY,
		ATCH_MAX_SEND_QUEUE, ATCH_MAX_JOURNAL, ATCH_MAX_CHECKPOINT};
	return kind < 0 || (size_t)kind >= sizeof(limits) / sizeof(limits[0]) ? 0 : limits[kind];
}

static int valid_child_name(const char *name)
{
	if (!name || !*name || !strcmp(name, ".") || !strcmp(name, "..") || strchr(name, '/')) {
		errno = EINVAL;
		return 0;
	}
	return 1;
}

int atch_alloc(enum atch_alloc_kind kind, size_t count, void **out)
{
	if (!out || !limit_for(kind) || count > limit_for(kind)) {
		errno = EOVERFLOW;
		return -1;
	}
	*out = calloc(count ? count : 1, 1);
	return *out ? 0 : -1;
}

int atch_storage_open_root(const char *path)
{
	struct stat st;
	int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
	if (fd < 0) return -1;
	if (fstat(fd, &st) < 0 || st.st_uid != getuid() || (st.st_mode & 0777) != 0700) {
		close(fd);
		errno = EPERM;
		return -1;
	}
	return fd;
}

int atch_storage_mkdir(int dirfd, const char *name)
{
	struct stat st;
	if (!valid_child_name(name)) return -1;
	if (mkdirat(dirfd, name, 0700) < 0 && errno != EEXIST) return -1;
	if (fstatat(dirfd, name, &st, AT_SYMLINK_NOFOLLOW) < 0 || !S_ISDIR(st.st_mode) ||
		st.st_uid != getuid() || (st.st_mode & 0777) != 0700) {
		errno = EPERM;
		return -1;
	}
	return 0;
}

int atch_storage_open_dir(int dirfd, const char *name)
{
	struct stat st;
	int fd;
	if (!valid_child_name(name)) return -1;
	fd = openat(dirfd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
	if (fd < 0) return -1;
	if (fstat(fd, &st) < 0 || st.st_uid != getuid() ||
	    (st.st_mode & 0777) != 0700) {
		int saved = errno ? errno : EPERM;
		close(fd);
		errno = saved;
		return -1;
	}
	return fd;
}

int atch_storage_open_file(int dirfd, const char *name, int flags, mode_t mode)
{
	struct stat st;
	if (!valid_child_name(name)) return -1;
	flags |= O_NOFOLLOW | O_CLOEXEC;
	int fd = openat(dirfd, name, flags, mode);
	if (fd < 0) return -1;
	if (fstat(fd, &st) < 0) {
		int saved = errno;
		close(fd);
		errno = saved;
		return -1;
	}
	if (st.st_uid != getuid() || (st.st_mode & 0777) != 0600) {
		close(fd);
		errno = EPERM;
		return -1;
	}
	if (fd >= 0 && (flags & O_CREAT) && fchmod(fd, 0600) < 0) { close(fd); return -1; }
	return fd;
}

int atch_storage_open_path_file(const char *path, int flags, mode_t mode)
{
	char parent[PATH_MAX];
	const char *slash;
	int dirfd, fd;

	if (!path || path[0] != '/' || strlen(path) >= sizeof(parent)) {
		errno = EINVAL;
		return -1;
	}
	slash = strrchr(path, '/');
	if (!slash || !slash[1] || (size_t)(slash - path) >= sizeof(parent)) {
		errno = EINVAL;
		return -1;
	}
	memcpy(parent, path, (size_t)(slash - path));
	parent[slash - path] = '\0';
	dirfd = atch_storage_open_root(parent[0] ? parent : "/");
	if (dirfd < 0) return -1;
	fd = atch_storage_open_file(dirfd, slash + 1, flags, mode);
	close(dirfd);
	return fd;
}

int atch_storage_open_sink(const char *root_path, const char *path, int flags, mode_t mode)
{
	size_t root_len;
	const char *name;
	int dirfd, fd;

	if (!root_path || !path || root_path[0] != '/' || path[0] != '/') {
		errno = EINVAL;
		return -1;
	}
	root_len = strlen(root_path);
	if (!root_len || (strncmp(root_path, path, root_len) != 0) ||
		(path[root_len] != '/' && path[root_len] != '\0')) {
		errno = EPERM;
		return -1;
	}
	name = path + root_len;
	if (*name == '/') name++;
	dirfd = atch_storage_open_root(root_path);
	if (dirfd < 0) return -1;
	fd = atch_storage_open_file(dirfd, name, flags, mode);
	close(dirfd);
	return fd;
}

int atch_storage_repair_stale_lock(int dirfd, const char *name)
{
	struct stat before, current;
	if (!valid_child_name(name)) return -1;
	int fd = openat(dirfd, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
	if (fd >= 0) { close(fd); return 0; }
	if (errno != EEXIST) return -1;
	fd = openat(dirfd, name, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
	if (fd < 0) return -1;
	if (flock(fd, LOCK_EX | LOCK_NB) < 0) { close(fd); return -1; }
	if (fstat(fd, &before) < 0) { int saved = errno; close(fd); errno = saved; return -1; }
	if (fstatat(dirfd, name, &current, AT_SYMLINK_NOFOLLOW) < 0 ||
		before.st_dev != current.st_dev || before.st_ino != current.st_ino) {
		close(fd);
		errno = EAGAIN;
		return -1;
	}
	char buf[32];
	ssize_t n = pread(fd, buf, sizeof(buf) - 1, 0);
	if (n <= 0 || n >= (ssize_t)sizeof(buf)) { close(fd); errno = EINVAL; return -1; }
	buf[n] = '\0';
	char *end;
	errno = 0;
	long pid = strtol(buf, &end, 10);
	if (errno == ERANGE || *end != '\0' || pid <= 0 || pid > PID_MAX ||
		(pid_t)pid != pid) { close(fd); errno = EINVAL; return -1; }
	if (kill((pid_t)pid, 0) == 0 || errno == EPERM) { close(fd); errno = EBUSY; return -1; }
	if (errno != ESRCH) { close(fd); return -1; }
	if (fstatat(dirfd, name, &current, AT_SYMLINK_NOFOLLOW) < 0 ||
		before.st_dev != current.st_dev || before.st_ino != current.st_ino) {
		int saved = errno ? errno : EAGAIN;
		close(fd);
		errno = saved;
		return -1;
	}
	/* Keep the exclusive lock fd open until the name is removed. */
	int result = unlinkat(dirfd, name, 0) == 0 ? 1 : -1;
	int saved = errno;
	close(fd);
	errno = saved;
	return result;
}
