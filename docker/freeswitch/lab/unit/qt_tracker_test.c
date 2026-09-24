/*
 * Unit test of the RCF quality patch v1 tracker (RFC 3550 A.1 sequence accounting +
 * RFC 3550 6.4.1 interarrival jitter). Compiles the tracker code extracted verbatim from
 * docker/freeswitch/patches/0001-rcf-rtp-quality-v1.patch (see run_unit.sh).
 *
 * Build twice: without -DQT_TEST_KERNEL (read-time fallback path) and with it
 * (SIOCGSTAMP path, ioctl mocked). run_unit.sh does both.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "qt_mock.h"

int64_t mock_read_now_us = 0;
int64_t mock_kernel_us = 0;
int     mock_ioctl_rc = 0;
int     mock_ioctl_calls = 0;

#include "qt_tracker.inc"

static int failures = 0, checks = 0;

#define CHECK(cond, ...) do { checks++; if (!(cond)) { failures++; \
	fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } } while (0)
#define CHECK_EQ(a, b) CHECK((unsigned long long)(a) == (unsigned long long)(b), "%s = %llu, want %llu", #a, \
	(unsigned long long)(a), (unsigned long long)(b))

#define PT_PCMU 0
#define PT_TE   101

static switch_socket_t g_sock = { 7 };

static void reset(switch_rtp_t *r)
{
	memset(r, 0, sizeof(*r));             /* FS: switch_core_alloc zero-fills the session */
	r->samples_per_second = 8000;
	r->recv_te = PT_TE;
	r->sock_input = &g_sock;
	mock_read_now_us = 1000000000;
	mock_kernel_us = 1000000000;
	mock_ioctl_rc = 0;
	mock_ioctl_calls = 0;
}

/* Deliver one packet: arrival at t_us (both clocks), RTP ts derived by caller. */
static void rx(switch_rtp_t *r, uint16_t seq, uint32_t ts, uint32_t ssrc, uint8_t pt, int64_t t_us)
{
	mock_read_now_us = t_us;
	mock_kernel_us = t_us;
	qt_track(r, seq, ts, ssrc, pt);
}

/* Steady 20 ms PCMU stream of n packets starting at seq0/ts0, skipping seqs in drop[]. */
static void stream(switch_rtp_t *r, uint16_t seq0, uint32_t ts0, uint32_t ssrc, int n, const int *drop, int ndrop, int64_t t0)
{
	int i, k;
	for (i = 0; i < n; i++) {
		int dropped = 0;
		for (k = 0; k < ndrop; k++) if (drop[k] == i) dropped = 1;
		if (dropped) continue;
		rx(r, (uint16_t)(seq0 + i), ts0 + (uint32_t)i * 160, ssrc, PT_PCMU, t0 + (int64_t)i * 20000);
	}
}

#define IN(r) ((r)->stats.inbound)

static void t_in_order(void)
{
	switch_rtp_t r; reset(&r);
	stream(&r, 1000, 5555, 0xAAAA, 1000, NULL, 0, 0);
	CHECK_EQ(IN(&r).seq_expected, 1000);
	CHECK_EQ(IN(&r).seq_received, 1000);
	CHECK_EQ(IN(&r).seq_lost, 0);
	CHECK_EQ(IN(&r).seq_loss_events, 0);
	CHECK_EQ(IN(&r).seq_reordered, 0);
	CHECK_EQ(IN(&r).seq_epochs, 1);
	/* perfectly periodic arrival => D == 0 => J == 0 */
	CHECK_EQ(IN(&r).rfc3550_jitter_n, 1000 - 1 - QT_JITTER_WARMUP);
	CHECK(IN(&r).rfc3550_jitter_max_ms == 0.0, "jitter max %f", IN(&r).rfc3550_jitter_max_ms);
}

static void t_loss_and_burst(void)
{
	/* single losses at 100, 300; burst of 5 at 500..504 => 7 lost, 3 loss events */
	int drop[] = { 100, 300, 500, 501, 502, 503, 504 };
	switch_rtp_t r; reset(&r);
	stream(&r, 1, 0, 0xB, 1000, drop, 7, 0);
	CHECK_EQ(IN(&r).seq_expected, 1000);
	CHECK_EQ(IN(&r).seq_received, 993);
	CHECK_EQ(IN(&r).seq_lost, 7);
	CHECK_EQ(IN(&r).seq_loss_events, 3);
	CHECK_EQ(IN(&r).seq_reordered, 0);
	/* the G.107 BurstR the API derives: (lost/events)*(1-p) = (7/3)*(1-0.007) */
	{
		double p = 7.0 / 1000.0, br = (7.0 / 3.0) * (1 - p);
		CHECK(br > 2.3 && br < 2.4, "burst_r %f", br);
	}
	/* trailing loss is invisible until a later packet arrives (RFC 3550 semantics) */
	{
		int drop2[] = { 998, 999 };
		reset(&r);
		stream(&r, 1, 0, 0xB, 1000, drop2, 2, 0);
		CHECK_EQ(IN(&r).seq_expected, 998);
		CHECK_EQ(IN(&r).seq_lost, 0);
	}
}

static void t_reorder(void)
{
	switch_rtp_t r; reset(&r);
	/* 1 2 4 3 5 : 3 arrives late, fills the gap */
	rx(&r, 1, 0, 1, PT_PCMU, 0);
	rx(&r, 2, 160, 1, PT_PCMU, 20000);
	rx(&r, 4, 480, 1, PT_PCMU, 40000);
	CHECK_EQ(IN(&r).seq_lost, 1);                       /* gap visible while 3 is outstanding */
	rx(&r, 3, 320, 1, PT_PCMU, 41000);
	rx(&r, 5, 640, 1, PT_PCMU, 60000);
	CHECK_EQ(IN(&r).seq_expected, 5);
	CHECK_EQ(IN(&r).seq_received, 5);
	CHECK_EQ(IN(&r).seq_lost, 0);                       /* reorder is NOT loss */
	CHECK_EQ(IN(&r).seq_reordered, 1);
	CHECK_EQ(IN(&r).seq_loss_events, 1);                /* documented: reorder inflates events (BurstR clamps >= 1) */
	/* 99 behind the highest: still "late" (udelta = 65437 > 65536 - QT_MAX_MISORDER) */
	reset(&r);
	stream(&r, 1000, 0, 2, 200, NULL, 0, 0);            /* max = 1199 */
	rx(&r, 1199 - 99, 0, 2, PT_PCMU, 9000000);
	CHECK_EQ(IN(&r).seq_epochs, 1);
	CHECK_EQ(IN(&r).seq_reordered, 1);
	/* exactly QT_MAX_MISORDER (100) behind: RFC 3550 A.1 treats it as a restart => new epoch */
	rx(&r, 1199 - 100, 0, 2, PT_PCMU, 9000001);
	CHECK_EQ(IN(&r).seq_epochs, 2);
}

static void t_duplicate(void)
{
	switch_rtp_t r; reset(&r);
	rx(&r, 10, 0, 3, PT_PCMU, 0);
	rx(&r, 11, 160, 3, PT_PCMU, 20000);
	rx(&r, 11, 160, 3, PT_PCMU, 20100);                 /* dup of highest: not counted as received */
	rx(&r, 12, 320, 3, PT_PCMU, 40000);
	CHECK_EQ(IN(&r).seq_expected, 3);
	CHECK_EQ(IN(&r).seq_received, 3);
	CHECK_EQ(IN(&r).seq_lost, 0);
	CHECK_EQ(IN(&r).seq_reordered, 1);
	/* dup of an older packet counts as late-received (RFC 3550 A.1 does the same); lost clamps at 0 */
	rx(&r, 11, 160, 3, PT_PCMU, 40100);
	CHECK_EQ(IN(&r).seq_received, 4);
	CHECK_EQ(IN(&r).seq_lost, 0);
	CHECK_EQ(IN(&r).seq_reordered, 2);
}

static void t_wrap(void)
{
	switch_rtp_t r; reset(&r);
	stream(&r, 65530, 0, 4, 20, NULL, 0, 0);            /* 65530..65535,0..13 */
	CHECK_EQ(IN(&r).seq_expected, 20);
	CHECK_EQ(IN(&r).seq_lost, 0);
	CHECK_EQ(r.qt_cycles, 65536);
	CHECK_EQ(IN(&r).seq_epochs, 1);
	{   /* loss straddling the wrap: 65535 and 0 dropped */
		int drop[] = { 5, 6 };
		reset(&r);
		stream(&r, 65530, 0, 4, 20, drop, 2, 0);
		CHECK_EQ(IN(&r).seq_expected, 20);
		CHECK_EQ(IN(&r).seq_lost, 2);
		CHECK_EQ(IN(&r).seq_loss_events, 1);
	}
	{   /* several wraps: 200k packets */
		reset(&r);
		stream(&r, 0, 0, 5, 200000, NULL, 0, 0);
		CHECK_EQ(IN(&r).seq_expected, 200000);
		CHECK_EQ(IN(&r).seq_lost, 0);
		CHECK_EQ(r.qt_cycles, 3u * 65536u);
	}
	{   /* late packet from before the wrap arriving after it */
		reset(&r);
		stream(&r, 65534, 0, 6, 2, NULL, 0, 0);          /* 65534, 65535 */
		rx(&r, 1, 480, 6, PT_PCMU, 60000);              /* 0 missing */
		CHECK_EQ(IN(&r).seq_lost, 1);
		rx(&r, 0, 320, 6, PT_PCMU, 61000);              /* late across the wrap */
		CHECK_EQ(IN(&r).seq_lost, 0);
		CHECK_EQ(IN(&r).seq_expected, 4);
		CHECK_EQ(IN(&r).seq_reordered, 1);
	}
}

static void t_ssrc_and_jump(void)
{
	int drop[] = { 50, 51, 52 };
	switch_rtp_t r; reset(&r);
	stream(&r, 1000, 0, 0xA, 500, drop, 3, 0);          /* epoch 1: 3 lost */
	stream(&r, 30000, 999999, 0xB, 500, NULL, 0, 10000000); /* SSRC change: new epoch, not loss */
	CHECK_EQ(IN(&r).seq_epochs, 2);
	CHECK_EQ(IN(&r).seq_expected, 1000);
	CHECK_EQ(IN(&r).seq_received, 997);
	CHECK_EQ(IN(&r).seq_lost, 3);                       /* epoch-1 loss frozen, never reset */
	CHECK_EQ(IN(&r).seq_loss_events, 1);
	/* same SSRC, seq jump >= 3000: new epoch, not 4999 lost */
	reset(&r);
	stream(&r, 100, 0, 0xC, 100, NULL, 0, 0);
	stream(&r, 5199, 16000, 0xC, 100, NULL, 0, 2000000);
	CHECK_EQ(IN(&r).seq_epochs, 2);
	CHECK_EQ(IN(&r).seq_expected, 200);
	CHECK_EQ(IN(&r).seq_lost, 0);
	/* jump of 2999 is still "in order after a gap": counted as loss */
	reset(&r);
	stream(&r, 100, 0, 0xD, 10, NULL, 0, 0);            /* max 109 */
	rx(&r, (uint16_t)(109 + 2999), 1600, 0xD, PT_PCMU, 200000);
	CHECK_EQ(IN(&r).seq_epochs, 1);
	CHECK_EQ(IN(&r).seq_lost, 2998);
	/* a single stray packet from another SSRC costs at most 1 packet of accounting */
	reset(&r);
	stream(&r, 1, 0, 0xE, 100, NULL, 0, 0);
	rx(&r, 40000, 0, 0xF00D, PT_PCMU, 2000000);         /* stray */
	stream(&r, 101, 16000, 0xE, 100, NULL, 0, 2000000);
	CHECK_EQ(IN(&r).seq_epochs, 3);
	CHECK_EQ(IN(&r).seq_expected, 201);
	CHECK_EQ(IN(&r).seq_received, 201);
	CHECK_EQ(IN(&r).seq_lost, 0);
}

static void t_dtmf_and_cn(void)
{
	/* RFC 2833 + CN share the seq space: no false loss; TE packets excluded from jitter */
	switch_rtp_t r; int i; uint16_t seq = 1;
	reset(&r);
	for (i = 0; i < 300; i++) {
		uint8_t pt = (i >= 100 && i < 110) ? PT_TE : (i >= 200 && i < 210 ? 13 : PT_PCMU);
		uint32_t ts = (pt == PT_TE) ? 100 * 160 : (uint32_t)i * 160;  /* 2833: ts = event start */
		rx(&r, seq++, ts, 9, pt, (int64_t)i * 20000);
	}
	CHECK_EQ(IN(&r).seq_expected, 300);
	CHECK_EQ(IN(&r).seq_lost, 0);
	CHECK(IN(&r).rfc3550_jitter_max_ms < 0.001, "TE ts leaked into jitter: max %f", IN(&r).rfc3550_jitter_max_ms);
	CHECK_EQ(IN(&r).rfc3550_jitter_n, 290 - 1 - QT_JITTER_WARMUP);
	/* DTX gap: 5 s silence, seq contiguous, ts advances with wall time => no loss, J stays ~0 */
	reset(&r);
	stream(&r, 1, 0, 9, 100, NULL, 0, 0);
	stream(&r, 101, 100 * 160 + 40000, 9, 100, NULL, 0, 99 * 20000 + 5000000 + 20000);
	CHECK_EQ(IN(&r).seq_lost, 0);
	CHECK(IN(&r).rfc3550_jitter_max_ms < 0.001, "DTX gap jitter %f", IN(&r).rfc3550_jitter_max_ms);
}

static void t_media_filters(void)
{
	switch_rtp_t r; reset(&r);
	r.flags[SWITCH_RTP_FLAG_VIDEO] = 1;
	stream(&r, 1, 0, 1, 100, NULL, 0, 0);
	CHECK_EQ(IN(&r).seq_epochs, 0);
	CHECK_EQ(IN(&r).seq_expected, 0);
	reset(&r);
	r.flags[SWITCH_RTP_FLAG_UDPTL] = 1;
	stream(&r, 1, 0, 1, 100, NULL, 0, 0);
	CHECK_EQ(IN(&r).seq_epochs, 0);
	/* 16 kHz RTP clock: sequence tracked, jitter not computed */
	reset(&r);
	r.samples_per_second = 16000;
	stream(&r, 1, 0, 1, 200, NULL, 0, 0);
	CHECK_EQ(IN(&r).seq_expected, 200);
	CHECK_EQ(IN(&r).rfc3550_jitter_n, 0);
}

/* RFC 3550 recurrence reference */
static void t_jitter_math(void)
{
	switch_rtp_t r; int i; double J = 0, sum = 0, mx = 0; int n = 0, samples = 0;
	reset(&r);
	/* arrival offset alternates 0 / +4 ms => |D| = 4 ms every packet */
	for (i = 0; i < 400; i++) {
		int64_t t = (int64_t)i * 20000 + ((i & 1) ? 4000 : 0);
		rx(&r, (uint16_t)(1 + i), (uint32_t)i * 160, 1, PT_PCMU, t);
		if (i > 0) {
			J += (4000.0 - J) / 16.0;
			if (++samples > QT_JITTER_WARMUP) { sum += J / 1000.0; n++; if (J / 1000.0 > mx) mx = J / 1000.0; }
		}
	}
	CHECK_EQ(IN(&r).rfc3550_jitter_n, n);
	CHECK(fabs(IN(&r).rfc3550_jitter_sum_ms / IN(&r).rfc3550_jitter_n - sum / n) < 1e-9, "avg %f vs %f",
		  IN(&r).rfc3550_jitter_sum_ms / IN(&r).rfc3550_jitter_n, sum / n);
	CHECK(fabs(IN(&r).rfc3550_jitter_max_ms - mx) < 1e-9, "max %f vs %f", IN(&r).rfc3550_jitter_max_ms, mx);
	CHECK(mx > 3.99 && mx <= 4.0, "J converges to |D|=4ms: %f", mx);
	/* RTP ts wrap (2^32) must not produce a spike */
	reset(&r);
	for (i = 0; i < 200; i++)
		rx(&r, (uint16_t)(1 + i), 0xFFFFF000u + (uint32_t)i * 160, 1, PT_PCMU, (int64_t)i * 20000);
	CHECK(IN(&r).rfc3550_jitter_max_ms < 0.001, "ts-wrap spike %f", IN(&r).rfc3550_jitter_max_ms);
}

/* Lab check #6 expectation: delay ~ N(mu, sigma) per packet => D ~ N(0, 2 sigma^2) =>
 * E|D| = 2 sigma / sqrt(pi) = 5.64 ms for sigma = 5 ms. (netem normal distribution.) */
static uint64_t rng = 0x9E3779B97F4A7C15ull;
static double urand(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return ((rng >> 11) + 0.5) / 9007199254740992.0; }
static double nrand(void) { return sqrt(-2 * log(urand())) * cos(2 * M_PI * urand()); }

static void t_jitter_gaussian(void)
{
	switch_rtp_t r; int i; double mean;
	reset(&r);
	for (i = 0; i < 30000; i++) {
		double d = 30000 + 5000 * nrand();  /* fed in seq order; on the wire netem may reorder ~0.2% of packets (late ones skip J) */
		rx(&r, (uint16_t)(1 + i), (uint32_t)i * 160, 1, PT_PCMU, (int64_t)i * 20000 + (int64_t)d);
	}
	mean = IN(&r).rfc3550_jitter_sum_ms / IN(&r).rfc3550_jitter_n;
	CHECK(mean > 0.95 * 5.642 && mean < 1.05 * 5.642, "gaussian mean J %f (want ~5.64)", mean);
	printf("  info: sigma=5ms gaussian delay -> mean J = %.3f ms (theory 2*sigma/sqrt(pi) = 5.642)\n", mean);
}

static void t_clock_source(void)
{
	switch_rtp_t r; int i;
	reset(&r);
	/* wire arrivals perfectly periodic; FS read time quantized/late by up to 19 ms */
	for (i = 0; i < 300; i++) {
		mock_kernel_us = (int64_t)i * 20000;
		mock_read_now_us = (int64_t)i * 20000 + ((i * 7919) % 19) * 1000;
		qt_track(&r, (uint16_t)(1 + i), (uint32_t)i * 160, 1, PT_PCMU);
	}
#ifdef QT_TEST_KERNEL
	CHECK_EQ(IN(&r).rfc3550_kernel_clock, 1);
	CHECK(IN(&r).rfc3550_jitter_max_ms < 0.001, "kernel clock should see wire time: %f", IN(&r).rfc3550_jitter_max_ms);
	CHECK(mock_ioctl_calls == 300, "ioctl calls %d", mock_ioctl_calls);
	/* ioctl starts failing mid-stream: fallback to read clock, and the clock switch must not
	 * difference kernel time against read time (would be a ~1e9 us spike) */
	mock_ioctl_rc = -1;
	for (i = 300; i < 400; i++) {
		mock_kernel_us = (int64_t)i * 20000;
		mock_read_now_us = 5000000000LL + (int64_t)i * 20000;
		qt_track(&r, (uint16_t)(1 + i), (uint32_t)i * 160, 1, PT_PCMU);
	}
	CHECK_EQ(IN(&r).rfc3550_kernel_clock, 0);
	CHECK(IN(&r).rfc3550_jitter_max_ms < 0.001, "clock switch spike %f", IN(&r).rfc3550_jitter_max_ms);
	/* NULL socket: no ioctl, fallback */
	reset(&r);
	r.sock_input = NULL;
	stream(&r, 1, 0, 1, 10, NULL, 0, 0);
	CHECK_EQ(mock_ioctl_calls, 0);
	CHECK_EQ(IN(&r).rfc3550_kernel_clock, 0);
#else
	CHECK_EQ(IN(&r).rfc3550_kernel_clock, 0);
	CHECK(IN(&r).rfc3550_jitter_max_ms > 1.0, "read clock is quantized, expected visible J: %f", IN(&r).rfc3550_jitter_max_ms);
	CHECK_EQ(mock_ioctl_calls, 0);
#endif
}

static void t_no_rtp(void)
{
	switch_rtp_t r; reset(&r);
	CHECK_EQ(IN(&r).seq_epochs, 0);                     /* exported as rtp_audio_in_seq_epochs=0 */
	CHECK_EQ(IN(&r).seq_expected, 0);
	CHECK_EQ(IN(&r).rfc3550_jitter_n, 0);               /* => jitter vars absent */
}

int main(void)
{
#ifdef QT_TEST_KERNEL
	printf("qt_tracker_test (SIOCGSTAMP path, ioctl mocked)\n");
#else
	printf("qt_tracker_test (read-time fallback path)\n");
#endif
	t_in_order();
	t_loss_and_burst();
	t_reorder();
	t_duplicate();
	t_wrap();
	t_ssrc_and_jump();
	t_dtmf_and_cn();
	t_media_filters();
	t_jitter_math();
	t_jitter_gaussian();
	t_clock_source();
	t_no_rtp();
	printf("%d checks, %d failures\n", checks, failures);
	return failures ? 1 : 0;
}
