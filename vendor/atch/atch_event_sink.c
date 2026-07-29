#define _POSIX_C_SOURCE 200809L

#include "atch_event_sink.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#define EVENT_LINE_MAX 2048
#define ESCAPED_TITLE_MAX 1024
#define ESCAPED_URI_MAX 1024

static size_t json_escape(const char *src, size_t srclen,
			  char *dst, size_t dstlen)
{
	size_t i, out = 0;

	for (i = 0; i < srclen; i++) {
		unsigned char c = (unsigned char)src[i];
		if (c == '"' || c == '\\') {
			if (out + 2 >= dstlen)
				break;
			dst[out++] = '\\';
			dst[out++] = (char)c;
		} else if (c < 0x20) {
			int n;
			if (out + 6 >= dstlen)
				break;
			n = snprintf(dst + out, dstlen - out, "\\u%04x", c);
			if (n < 0 || (size_t)n >= dstlen - out)
				break;
			out += (size_t)n;
		} else {
			if (out + 1 >= dstlen)
				break;
			dst[out++] = (char)c;
		}
	}
	return out;
}

static size_t format_line(const char *body, char *line, size_t line_len)
{
	struct timeval now;
	int n;

	if (gettimeofday(&now, NULL) < 0)
		return 0;
	n = snprintf(line, line_len, "{\"ts\":%lld.%03ld,%s}\n",
		     (long long)now.tv_sec, now.tv_usec / 1000L, body);
	if (n < 0 || (size_t)n >= line_len)
		return 0;
	return (size_t)n;
}

static int append_line(struct atch_event_sink *sink,
		       const char *line, size_t length)
{
	size_t offset = 0;

	if (length > sink->cap - sink->written)
		return -1;
	while (offset < length) {
		ssize_t written = write(sink->fd, line + offset, length - offset);
		if (written < 0 && errno == EINTR)
			continue;
		if (written <= 0) {
			sink->written += offset;
			return -1;
		}
		offset += (size_t)written;
	}
	sink->written += offset;
	return 0;
}

static int append_body(struct atch_event_sink *sink, const char *body)
{
	char line[EVENT_LINE_MAX];
	size_t length = format_line(body, line, sizeof(line));

	if (length == 0)
		return -1;
	return append_line(sink, line, length);
}

static int compact_sink(struct atch_event_sink *sink)
{
	if (ftruncate(sink->fd, 0) < 0)
		return -1;
	if (lseek(sink->fd, 0, SEEK_SET) < 0)
		return -1;
	sink->written = 0;
	if (sink->ready_seen &&
	    append_body(sink, "\"type\":\"ready\"") < 0)
		return -1;
	if (sink->state_seen &&
	    append_body(sink, sink->state_body) < 0)
		return -1;
	if (sink->link_seen &&
	    append_body(sink, sink->link_body) < 0)
		return -1;
	return 0;
}

static void emit_body(struct atch_event_sink *sink, const char *body,
		      int included_in_snapshot)
{
	char line[EVENT_LINE_MAX];
	size_t length;

	if (!sink || sink->fd < 0)
		return;
	length = format_line(body, line, sizeof(line));
	if (length == 0 || length > sink->cap)
		return;
	if (sink->written > sink->cap - length) {
		if (compact_sink(sink) < 0)
			return;
		if (included_in_snapshot)
			return;
	}
	(void)append_line(sink, line, length);
}

int atch_event_sink_init(struct atch_event_sink *sink, int fd, size_t cap)
{
	struct stat stat;

	if (!sink || fd < 0 || cap < ATCH_EVENT_SINK_MIN_CAP) {
		errno = EINVAL;
		return -1;
	}
	if (fstat(fd, &stat) < 0)
		return -1;
	if (stat.st_size < 0) {
		errno = EINVAL;
		return -1;
	}
	if ((size_t)stat.st_size > cap) {
		if (ftruncate(fd, 0) < 0)
			return -1;
		if (lseek(fd, 0, SEEK_SET) < 0)
			return -1;
		stat.st_size = 0;
	}
	memset(sink, 0, sizeof(*sink));
	sink->fd = fd;
	sink->cap = cap;
	sink->written = (size_t)stat.st_size;
	return 0;
}

void atch_event_sink_emit_ready(struct atch_event_sink *sink)
{
	if (!sink)
		return;
	sink->ready_seen = 1;
	emit_body(sink, "\"type\":\"ready\"", 1);
}

void atch_event_sink_emit_state(struct atch_event_sink *sink, int busy,
				const char *title)
{
	char escaped[ESCAPED_TITLE_MAX];
	size_t escaped_len;
	int n;

	if (!sink || !title)
		return;
	escaped_len = json_escape(title, strlen(title), escaped,
				  sizeof(escaped) - 1);
	escaped[escaped_len] = '\0';
	n = snprintf(sink->state_body, sizeof(sink->state_body),
		     "\"type\":\"state\",\"state\":\"%s\",\"title\":\"%s\"",
		     busy ? "busy" : "idle", escaped);
	if (n < 0 || (size_t)n >= sizeof(sink->state_body))
		return;
	sink->state_seen = 1;
	emit_body(sink, sink->state_body, 1);
}

void atch_event_sink_emit_link(struct atch_event_sink *sink, const char *uri)
{
	char escaped[ESCAPED_URI_MAX];
	size_t escaped_len;
	int n;

	if (!sink || !uri)
		return;
	escaped_len = json_escape(uri, strlen(uri), escaped,
				  sizeof(escaped) - 1);
	escaped[escaped_len] = '\0';
	n = snprintf(sink->link_body, sizeof(sink->link_body),
		     "\"type\":\"link\",\"uri\":\"%s\"", escaped);
	if (n < 0 || (size_t)n >= sizeof(sink->link_body))
		return;
	sink->link_seen = 1;
	emit_body(sink, sink->link_body, 1);
}

void atch_event_sink_emit_exit(struct atch_event_sink *sink, int code)
{
	char body[64];
	int n = snprintf(body, sizeof(body),
			 "\"type\":\"exit\",\"code\":%d", code);

	if (n < 0 || (size_t)n >= sizeof(body))
		return;
	emit_body(sink, body, 0);
}
