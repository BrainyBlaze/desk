#define _POSIX_C_SOURCE 200809L

#include "atch_event_sink.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define TEST_CAP 8192

static void fail(const char *message)
{
	fprintf(stderr, "test_event_sink: %s\n", message);
	exit(1);
}

static void write_bytes(int fd, const char *bytes, size_t len)
{
	size_t offset = 0;

	while (offset < len) {
		ssize_t written = write(fd, bytes + offset, len - offset);
		if (written <= 0)
			fail("could not prepare oversized sink");
		offset += (size_t)written;
	}
}

static char *read_sink(int fd, size_t *length)
{
	struct stat stat;
	char *contents;
	size_t offset = 0;

	if (fstat(fd, &stat) < 0)
		fail("could not stat sink");
	contents = malloc((size_t)stat.st_size + 1);
	if (!contents)
		fail("could not allocate sink buffer");
	if (lseek(fd, 0, SEEK_SET) < 0)
		fail("could not seek sink");
	while (offset < (size_t)stat.st_size) {
		ssize_t got = read(fd, contents + offset,
				   (size_t)stat.st_size - offset);
		if (got <= 0)
			fail("could not read sink");
		offset += (size_t)got;
	}
	contents[offset] = '\0';
	*length = offset;
	return contents;
}

int main(void)
{
	char path[] = "/tmp/atch-event-sink-test.XXXXXX";
	char oversized[TEST_CAP + 1];
	char uri[512];
	char *contents;
	struct atch_event_sink sink;
	struct stat stat;
	size_t length;
	int fd, i;

	fd = mkstemp(path);
	if (fd < 0)
		fail("could not create sink");
	memset(oversized, 'x', sizeof(oversized));
	write_bytes(fd, oversized, sizeof(oversized));

	if (atch_event_sink_init(&sink, fd, TEST_CAP) < 0)
		fail("could not initialize sink");
	if (fstat(fd, &stat) < 0 || stat.st_size != 0)
		fail("oversized preexisting sink was not truncated");

	atch_event_sink_emit_ready(&sink);
	for (i = 0; i < 200; i++) {
		int prefix = snprintf(uri, sizeof(uri),
				      "https://example.test/%03d/", i);
		if (prefix < 0 || (size_t)prefix >= sizeof(uri) - 1)
			fail("could not format test URI");
		memset(uri + prefix, 'a' + (i % 26),
		       sizeof(uri) - (size_t)prefix - 1);
		uri[sizeof(uri) - 1] = '\0';
		atch_event_sink_emit_link(&sink, uri);
	}
	atch_event_sink_emit_state(&sink, 0, "latest-state");
	atch_event_sink_emit_exit(&sink, 7);

	if (fstat(fd, &stat) < 0 || stat.st_size > TEST_CAP)
		fail("event sink exceeded its hard cap");
	contents = read_sink(fd, &length);
	if (length == 0 || contents[length - 1] != '\n')
		fail("event sink ended with a partial record");
	if (!strstr(contents, "\"type\":\"ready\""))
		fail("compaction lost ready state");
	if (!strstr(contents,
		    "\"type\":\"state\",\"state\":\"idle\",\"title\":\"latest-state\""))
		fail("compaction lost latest terminal state");
	if (!strstr(contents, "\"uri\":\"https://example.test/199/"))
		fail("compaction lost latest link");
	if (!strstr(contents, "\"type\":\"exit\",\"code\":7"))
		fail("compaction lost exit");
	if (strstr(contents, "\"uri\":\"https://example.test/000/"))
		fail("compaction retained unbounded old history");

	free(contents);
	close(fd);
	unlink(path);
	puts("test_event_sink: ok");
	return 0;
}
