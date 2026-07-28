#ifndef ATCH_EVENT_SINK_H
#define ATCH_EVENT_SINK_H

#include <stddef.h>

#define ATCH_EVENT_SINK_DEFAULT_CAP ((size_t)1024 * 1024)
#define ATCH_EVENT_SINK_MIN_CAP ((size_t)8192)
#define ATCH_EVENT_STATE_BODY_MAX 1100
#define ATCH_EVENT_LINK_BODY_MAX 1200

struct atch_event_sink {
	int fd;
	size_t cap;
	size_t written;
	int ready_seen;
	int state_seen;
	char state_body[ATCH_EVENT_STATE_BODY_MAX];
	int link_seen;
	char link_body[ATCH_EVENT_LINK_BODY_MAX];
};

int atch_event_sink_init(struct atch_event_sink *sink, int fd, size_t cap);
void atch_event_sink_emit_ready(struct atch_event_sink *sink);
void atch_event_sink_emit_state(struct atch_event_sink *sink, int busy,
				const char *title);
void atch_event_sink_emit_link(struct atch_event_sink *sink, const char *uri);
void atch_event_sink_emit_exit(struct atch_event_sink *sink, int code);

#endif
