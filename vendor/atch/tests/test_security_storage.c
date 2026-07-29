#define _GNU_SOURCE
#include "atch_security.h"
#include "atch_storage.h"

#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <locale.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <signal.h>
#include <unistd.h>

static void test_trusted_root_and_nofollow(void)
{
	char path[] = "/tmp/atch-security-XXXXXX";
	struct stat st;
	int root = mkdtemp(path) ? atch_storage_open_root(path) : -1;
	assert(root >= 0);
	assert(fstat(root, &st) == 0);
	assert((st.st_mode & 0777) == 0700);
	assert(atch_storage_mkdir(root, "sessions") == 0);
	assert(atch_storage_open_dir(root, "sessions") >= 0);
	assert(atch_storage_open_dir(root, "../sessions") < 0);
	assert(errno == EINVAL);
	assert(atch_storage_open_file(root, "state", O_RDWR | O_CREAT, 0600) >= 0);
	assert(atch_storage_open_file(root, "state", O_RDONLY | O_NOFOLLOW, 0600) >= 0);
	assert(atch_storage_open_file(root, "missing", O_RDONLY, 0600) < 0);
	assert(symlink("sessions", "/tmp/atch-security-link") == 0);
	assert(atch_storage_open_dir(root, "../atch-security-link") < 0);
	unlink("/tmp/atch-security-link");
	close(root);
	rmdir(path);
}

static void test_limits_and_peer_uid(void)
{
	int sv[2];
	void *p = NULL;
	assert(atch_alloc(ATCH_ALLOC_PAYLOAD, 8, &p) == 0 && p != NULL);
	free(p);
	assert(atch_alloc(ATCH_ALLOC_PAYLOAD, ATCH_MAX_PAYLOAD + 1, &p) == -1);
	assert(errno == EOVERFLOW);
	assert(atch_alloc(ATCH_ALLOC_GEOMETRY, 1, &p) == 0);
	free(p);
	assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0);
	assert(atch_security_peer_uid(sv[0], getuid()) == 0);
	assert(atch_security_peer_uid(sv[0], getuid() + 1) == -1);
	close(sv[0]);
	close(sv[1]);
}

static void test_lock_and_process_normalization(void)
{
	char path[] = "/tmp/atch-lock-XXXXXX";
	int root = mkdtemp(path) ? atch_storage_open_root(path) : -1;
	int fd;
	assert(root >= 0);
	assert(atch_storage_repair_stale_lock(root, "lock") == 0);
	assert(atch_storage_repair_stale_lock(root, "lock") < 0);
	fd = atch_storage_open_file(root, "stale", O_WRONLY | O_CREAT, 0600);
	assert(fd >= 0);
	assert(write(fd, "999999", 6) == 6);
	close(fd);
	assert(atch_storage_repair_stale_lock(root, "stale") == 1);
	fd = atch_storage_open_file(root, "malformed", O_WRONLY | O_CREAT, 0600);
	assert(fd >= 0);
	assert(write(fd, "12x", 3) == 3);
	close(fd);
	assert(atch_storage_repair_stale_lock(root, "malformed") < 0);
	assert(errno == EINVAL);
	fd = atch_storage_open_file(root, "negative", O_WRONLY | O_CREAT, 0600);
	assert(fd >= 0);
	assert(write(fd, "-1", 2) == 2);
	close(fd);
	assert(atch_storage_repair_stale_lock(root, "negative") < 0);
	assert(errno == EINVAL);
	fd = atch_storage_open_file(root, "too-large", O_WRONLY | O_CREAT, 0600);
	assert(fd >= 0);
	assert(write(fd, "999999999999999999999", 21) == 21);
	close(fd);
	assert(atch_storage_repair_stale_lock(root, "too-large") < 0);
	assert(errno == EINVAL);
	assert(atch_security_normalize_process() == 0);
	assert(setlocale(LC_CTYPE, NULL) != NULL);
	close(root);
	rmdir(path);
}

static void test_trusted_sink(void)
{
	char root_path[] = "/tmp/atch-sink-XXXXXX";
	char inside[PATH_MAX];
	struct stat st;
	int root, fd;

	assert(mkdtemp(root_path) != NULL);
	root = atch_storage_open_root(root_path);
	assert(root >= 0);
	close(root);
	snprintf(inside, sizeof(inside), "%s/events", root_path);
	fd = atch_storage_open_sink(root_path, inside, O_WRONLY | O_CREAT, 0600);
	assert(fd >= 0);
	assert(fstat(fd, &st) == 0 && (st.st_mode & 0777) == 0600);
	assert(fcntl(fd, F_GETFD) & FD_CLOEXEC);
	close(fd);
	assert(atch_storage_open_sink(root_path, "/tmp/atch-events", O_WRONLY | O_CREAT, 0600) < 0);
	assert(errno == EPERM);
	unlink(inside);
	rmdir(root_path);
}

int main(void)
{
	test_trusted_root_and_nofollow();
	test_limits_and_peer_uid();
	test_lock_and_process_normalization();
	test_trusted_sink();
	puts("security/storage tests: ok");
	return 0;
}
