#include "atch.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int state_calls;
static int last_busy;
static int ready_calls;
static int link_calls;
static char last_link[128];

static void fail(const char *message, size_t split)
{
	fprintf(stderr, "test_tstate: %s (split=%zu)\n", message, split);
	exit(1);
}

static void on_state(int busy)
{
	state_calls++;
	last_busy = busy;
}

static void on_ready(void)
{
	ready_calls++;
}

static void on_link(const char *uri)
{
	link_calls++;
	snprintf(last_link, sizeof(last_link), "%s", uri);
}

static void reset_observers(void)
{
	state_calls = 0;
	last_busy = -1;
	ready_calls = 0;
	link_calls = 0;
	last_link[0] = '\0';
	tstate_reset();
	tstate_set_state_callback(on_state);
	tstate_set_ready_callback(on_ready);
	tstate_set_link_callback(on_link);
}

static void scan_split(const unsigned char *sequence, size_t len, size_t split)
{
	tstate_scan(sequence, split);
	tstate_scan(sequence + split, len - split);
}

static void test_title_across_every_split(void)
{
	static const unsigned char sequence[] = "\033]0;\342\240\200 project\033\\";
	size_t split;

	for (split = 1; split < sizeof(sequence) - 1; split++) {
		reset_observers();
		scan_split(sequence, sizeof(sequence) - 1, split);
		if (state_calls != 1 || last_busy != 1)
			fail("split OSC 0 did not report busy", split);
		if (strcmp(tstate_get_title(), "\342\240\200 project") != 0)
			fail("split OSC 0 lost the title", split);
	}
}

static void test_link_across_every_split(void)
{
	static const unsigned char sequence[] =
		"\033]8;id=desk;https://example.test/run\033\\";
	size_t split;

	for (split = 1; split < sizeof(sequence) - 1; split++) {
		reset_observers();
		scan_split(sequence, sizeof(sequence) - 1, split);
		if (link_calls != 1)
			fail("split OSC 8 did not report a link", split);
		if (strcmp(last_link, "https://example.test/run") != 0)
			fail("split OSC 8 changed the link", split);
	}
}

static void test_ready_across_every_split(void)
{
	static const unsigned char sequence[] = "\033[>q";
	size_t split;

	for (split = 1; split < sizeof(sequence) - 1; split++) {
		reset_observers();
		scan_split(sequence, sizeof(sequence) - 1, split);
		if (ready_calls != 1)
			fail("split XTVERSION did not report ready", split);
	}
}

static void test_decset_across_every_split(void)
{
	static const unsigned char sequence[] = "\033[?1004h";
	unsigned char preamble[64];
	size_t split, written;

	for (split = 1; split < sizeof(sequence) - 1; split++) {
		reset_observers();
		scan_split(sequence, sizeof(sequence) - 1, split);
		written = tstate_emit_preamble(preamble, sizeof(preamble));
		if (written != sizeof(sequence) - 1 ||
		    memcmp(preamble, sequence, written) != 0)
			fail("split DECSET was not retained", split);
	}
}

static void test_reset_discards_partial_sequence(void)
{
	static const unsigned char prefix[] = "\033]0;\342\240\200";
	static const unsigned char suffix[] = " project\007";

	reset_observers();
	tstate_scan(prefix, sizeof(prefix) - 1);
	tstate_reset();
	tstate_scan(suffix, sizeof(suffix) - 1);
	if (state_calls != 0)
		fail("reset completed a pre-reset OSC", sizeof(prefix) - 1);
}

static void test_overflow_recovers_for_next_sequence(void)
{
	unsigned char fragment[BUFSIZE];
	static const unsigned char valid[] = "\033]0;idle\007";

	reset_observers();
	memset(fragment, 'x', sizeof(fragment));
	fragment[0] = 0x1b;
	fragment[1] = ']';
	fragment[2] = '0';
	fragment[3] = ';';
	tstate_scan(fragment, sizeof(fragment));
	tstate_scan((const unsigned char *)"overflow", 8);
	tstate_scan(valid, sizeof(valid) - 1);
	if (state_calls != 1 || last_busy != 0)
		fail("scanner did not recover after an oversized OSC", BUFSIZE);
}

static void test_pending_csi_is_bounded_across_reads(void)
{
	unsigned char fragment[BUFSIZE];
	static const unsigned char valid[] = "\033]0;idle\007";

	reset_observers();
	memset(fragment, '1', sizeof(fragment));
	fragment[0] = 0x1b;
	fragment[1] = '[';
	fragment[2] = '?';
	tstate_scan(fragment, sizeof(fragment));
	tstate_scan(fragment, sizeof(fragment));
	tstate_scan(valid, sizeof(valid) - 1);
	if (state_calls != 1 || last_busy != 0)
		fail("scanner did not recover after a multi-read CSI overflow",
		     BUFSIZE);
}

static void expect_preamble_unchanged(const unsigned char *sequence,
				      size_t len, const char *message)
{
	unsigned char before[BUFSIZE], after[BUFSIZE];
	size_t before_len, after_len;

	reset_observers();
	before_len = tstate_emit_preamble(before, sizeof(before));
	tstate_scan(sequence, len);
	after_len = tstate_emit_preamble(after, sizeof(after));
	if (before_len != after_len || memcmp(before, after, before_len) != 0)
		fail(message, len);
}

static void test_numeric_overflow_is_rejected(void)
{
	static const unsigned char decset_alias[] = "\033[?4294968300h";
	static const unsigned char kitty_alias[] = "\033[>4294967297u";
	static const unsigned char huge_decset[] =
		"\033[?999999999999999999999999999999999999999999999999999999999999"
		"9999999999999999999999999999999999999999h";
	static const unsigned char osc_alias[] =
		"\033]4294967296;\342\240\200 project\007";

	expect_preamble_unchanged(decset_alias, sizeof(decset_alias) - 1,
				 "overflowing DECSET aliased a tracked mode");
	expect_preamble_unchanged(kitty_alias, sizeof(kitty_alias) - 1,
				 "overflowing kitty flags changed keyboard state");
	expect_preamble_unchanged(huge_decset, sizeof(huge_decset) - 1,
				 "oversized DECSET changed terminal state");

	reset_observers();
	tstate_scan(osc_alias, sizeof(osc_alias) - 1);
	if (state_calls != 0 || tstate_get_title()[0] != '\0')
		fail("overflowing OSC command aliased OSC 0", sizeof(osc_alias) - 1);
}

int main(void)
{
	test_title_across_every_split();
	test_link_across_every_split();
	test_ready_across_every_split();
	test_decset_across_every_split();
	test_reset_discards_partial_sequence();
	test_overflow_recovers_for_next_sequence();
	test_pending_csi_is_bounded_across_reads();
	test_numeric_overflow_is_rejected();
	puts("test_tstate: ok");
	return 0;
}
