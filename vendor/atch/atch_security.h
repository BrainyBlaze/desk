#ifndef ATCH_SECURITY_H
#define ATCH_SECURITY_H

#include <stddef.h>
#include <sys/types.h>

int atch_security_peer_uid(int fd, uid_t expected);
int atch_security_close_from(int first_fd, const int *allow, size_t allow_count);
int atch_security_normalize_process(void);

#endif
