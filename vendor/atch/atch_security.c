#define _GNU_SOURCE
#include "atch_security.h"

#include <errno.h>
#include <fcntl.h>
#include <locale.h>
#include <signal.h>
#include <sys/socket.h>

int atch_security_peer_uid(int fd, uid_t expected)
{
	struct ucred cred;
	socklen_t len = sizeof(cred);
	if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) < 0)
		return -1;
	if (cred.uid != expected) {
		errno = EPERM;
		return -1;
	}
	return 0;
}

int atch_security_close_from(int first_fd, const int *allow, size_t allow_count)
{
	int max = getdtablesize();
	for (int fd = first_fd; fd < max; fd++) {
		int keep = 0;
		for (size_t i = 0; i < allow_count; i++) keep |= allow[i] == fd;
		if (!keep) close(fd);
	}
	return 0;
}

int atch_security_normalize_process(void)
{
	struct sigaction sa = {0};
	sa.sa_handler = SIG_DFL;
	sigemptyset(&sa.sa_mask);
	for (int sig = 1; sig < NSIG; sig++)
		if (sig != SIGKILL && sig != SIGSTOP) sigaction(sig, &sa, NULL);
	if (!setlocale(LC_ALL, "C")) {
		errno = EINVAL;
		return -1;
	}
	return 0;
}
