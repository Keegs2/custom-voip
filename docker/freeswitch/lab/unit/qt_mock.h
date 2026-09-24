/*
 * qt_mock.h — minimal stand-ins for the FreeSWITCH types the RCF quality-patch tracker
 * touches, so the tracker code can be compiled and unit-tested WITHOUT a FreeSWITCH tree.
 *
 * The struct FIELD DECLARATIONS are not copied here: run_unit.sh extracts them verbatim
 * from docker/freeswitch/patches/0001-rcf-rtp-quality-v1.patch into
 * qt_fields_public.inc (switch_types.h hunk) / qt_fields_private.inc (struct switch_rtp
 * hunk), and the tracker functions into qt_tracker.inc. The test therefore exercises the
 * exact bytes the Docker build compiles.
 */
#ifndef QT_MOCK_H
#define QT_MOCK_H

#include <stdint.h>
#include <stddef.h>
#include <sys/time.h>

typedef size_t switch_size_t;             /* FS: uintptr_t-sized on LP64 */
typedef int switch_os_socket_t;           /* switch_types.h:2328 (non-Windows) */
#define SWITCH_SOCK_INVALID -1            /* switch_types.h:2329 */
typedef int switch_status_t;
#define SWITCH_STATUS_SUCCESS 0
#define SWITCH_STATUS_FALSE 1
typedef struct mock_socket { int fd; } switch_socket_t;

typedef enum {
	SWITCH_RTP_FLAG_VIDEO,
	SWITCH_RTP_FLAG_TEXT,
	SWITCH_RTP_FLAG_UDPTL,
	SWITCH_RTP_FLAG_INVALID
} switch_rtp_flag_t;

typedef struct {
	switch_size_t packet_count;           /* stand-in for the untouched pre-existing fields */
#include "qt_fields_public.inc"
} switch_rtp_numbers_t;

typedef struct {
	switch_rtp_numbers_t inbound;
} switch_rtp_stats_t;

typedef struct switch_rtp {
	uint8_t flags[SWITCH_RTP_FLAG_INVALID];
	switch_socket_t *sock_input;
	uint32_t samples_per_second;
	uint8_t recv_te;                      /* switch_payload_t */
	switch_rtp_stats_t stats;
#include "qt_fields_private.inc"
} switch_rtp_t;

/* ---- clocks ---- */
extern int64_t mock_read_now_us;          /* what switch_micro_time_now() returns (read time) */
extern int64_t mock_kernel_us;            /* what SIOCGSTAMP returns (wire time) */
extern int     mock_ioctl_rc;             /* 0 = SIOCGSTAMP succeeds */
extern int     mock_ioctl_calls;

static inline int64_t switch_micro_time_now(void) { return mock_read_now_us; }

#ifdef QT_TEST_KERNEL
#define SIOCGSTAMP 0x8906
static inline switch_status_t switch_os_sock_get(switch_os_socket_t *thesock, switch_socket_t *sock)
{
	*thesock = sock->fd;
	return SWITCH_STATUS_SUCCESS;
}
static inline int ioctl(int fd, unsigned long req, struct timeval *tv)
{
	(void)fd;
	mock_ioctl_calls++;
	if (req != SIOCGSTAMP || mock_ioctl_rc != 0) return -1;
	tv->tv_sec = (time_t)(mock_kernel_us / 1000000);
	tv->tv_usec = (suseconds_t)(mock_kernel_us % 1000000);
	return 0;
}
#endif

#endif
