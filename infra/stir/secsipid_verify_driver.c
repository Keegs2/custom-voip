/*
 * secsipid_verify_driver.c
 * ------------------------------------------------------------------------
 * Thin CLI driver over the REAL libsecsipid (the same shared library the
 * Kamailio `secsipid` module links). It exercises the exact code path that
 * `secsipid_check_identity("")` runs inside kamailio.cfg:
 *
 *   1. SecSIPIDOptSetN("CertVerify", <bitmask>)   <- modparam libopt CertVerify
 *   2. SecSIPIDOptSetS("CertCAFile", <roots.pem>)  <- modparam libopt CertCAFile
 *   3. SecSIPIDOptSetS("CertCAInter", <inter.pem>) <- modparam libopt CertCAInter
 *   4. SecSIPIDCheckFull(identity, expire, NULL, 0) <- the actual verify
 *
 * SecSIPIDCheckFull with a NULL/empty pubkey path makes libsecsipid FETCH the
 * leaf cert from the PASSporT `info=`/x5u URL (http/https/file), verify the
 * ES256 JWT signature with that leaf, and — governed ENTIRELY by the CertVerify
 * bitmask + the CA files above — optionally chain-validate the fetched leaf up
 * to the trusted STI-CA root(s). This is byte-for-byte the trust logic the SBC
 * uses on the inbound INVITE path; we are proving the library, not re-deriving
 * crypto.
 *
 * Return convention (matches libsecsipid): the function returns 0 on a VALID
 * PASSporT (+ chain, if CertVerify>0) and a NEGATIVE value on ANY failure
 * (bad signature, untrusted/expired cert, fetch error, malformed token). The
 * Kamailio wrapper maps 0 -> true (PASS) and <0 -> false (FAIL-open annotate).
 * We mirror that: exit 0 == PASS, exit 1 == FAIL (verify returned <0),
 * exit 2 == usage/driver error.
 *
 * Build (inside the kamailio image, which ships libsecsipid.so.1):
 *   cc -O2 -Wall -Wextra -o secsipid_verify_driver secsipid_verify_driver.c \
 *      -lsecsipid
 * (a versioned -l needs the .so symlink; the self-test creates one, or we link
 *  the SONAME directly — see the script.)
 * ------------------------------------------------------------------------
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * libsecsipid 1.2.0 public API. We declare the prototypes ourselves because the
 * image ships no -dev header. These are the AUTHORITATIVE c-shared cgo exports
 * from asipto/secsipidx v1.2.0 (csecsipid/csecsipid.go, `//export`):
 *
 *   int SecSIPIDCheckFull(char* identityVal, int identityLen, int expireVal,
 *                         char* pubkeyPath, int timeoutVal);
 *   int SecSIPIDOptSetS(char* sName, char* sValue);
 *   int SecSIPIDOptSetN(char* sName, int nValue);
 *
 * ⚠️ ABI: SecSIPIDCheckFull takes FIVE args, in this order:
 *   (1) identityVal  — the Identity header value (compact JWS + ;info=<x5u>;...).
 *   (2) identityLen  — its BYTE LENGTH (0 => the lib does strlen via GoString;
 *                      NON-zero => GoStringN reads exactly that many bytes, so a
 *                      WRONG length truncates/overruns the identity and yields a
 *                      spurious SIP-header parse error (-301/-303), NOT a crypto
 *                      result). We pass the true strlen to be unambiguous.
 *   (3) expireVal    — PASSporT `iat` freshness WINDOW in seconds. The lib fails
 *                      with -232 (SJWTRetErrJSONPayloadIATExpired) when
 *                      `now > iat + expireVal`. expireVal=0 therefore rejects EVERY
 *                      already-issued token. Kamailio's module passes its
 *                      `modparam expire` (default 300); we mirror that default.
 *   (4) pubkeyPath   — NULL/"" => download the leaf via the PASSporT x5u (info=).
 *   (5) timeoutVal   — x5u fetch timeout in seconds (module: `modparam timeout`=5).
 *
 * This byte-for-byte mirrors how Kamailio 5.8 invokes it in production
 * (src/modules/secsipid/secsipid_mod.c):
 *   SecSIPIDCheckFull(ibody.s, ibody.len, secsipid_expire, keypath->s,
 *                     secsipid_timeout);
 * An earlier version of this driver declared a 4-arg form — that mismatched the
 * real ABI: the driver's "expire" landed in identityLen and expireVal was forced
 * to 0, so every verify failed structurally. Fixed to the true 5-arg signature.
 */
extern int SecSIPIDCheckFull(char *identityVal, int identityLen, int expireVal,
                             char *pubkeyPath, int timeoutVal);
extern int SecSIPIDOptSetS(char *sName, char *sValue);
extern int SecSIPIDOptSetN(char *sName, int nValue);

static void usage(const char *argv0) {
    fprintf(stderr,
        "usage: %s --identity-file <passport.txt> --certverify <N> "
        "[--cafile <roots.pem>] [--cainter <inter.pem>] [--expire <secs>] "
        "[--timeout <secs>]\n"
        "  Verifies a full SHAKEN Identity header value with libsecsipid.\n"
        "  --certverify N : CertVerify bitmask (0=sig-only, 1=time, 2=sysCA, "
        "4=custCA(CAFile), 8=inter). Matches modparam libopt CertVerify.\n"
        "  exit 0=PASS(valid), 1=FAIL(verify<0), 2=driver error.\n",
        argv0);
}

/* Read an entire file into a heap buffer (NUL-terminated). Caller frees. */
static char *slurp(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long n = ftell(f);
    if (n < 0) { fclose(f); return NULL; }
    if (fseek(f, 0, SEEK_SET) != 0) { fclose(f); return NULL; }
    char *buf = (char *)malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t got = fread(buf, 1, (size_t)n, f);
    fclose(f);
    buf[got] = '\0';
    /* Trim a single trailing newline so the Identity value is clean. */
    while (got > 0 && (buf[got - 1] == '\n' || buf[got - 1] == '\r')) {
        buf[--got] = '\0';
    }
    return buf;
}

int main(int argc, char **argv) {
    const char *identity_file = NULL;
    const char *cafile = NULL;
    const char *cainter = NULL;
    int certverify = -1;      /* required */
    int expire = 300;         /* iat freshness WINDOW (s); mirrors modparam expire=300 */
    int timeout = 5;          /* x5u fetch timeout (s); mirrors modparam timeout=5 */

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--identity-file") && i + 1 < argc) {
            identity_file = argv[++i];
        } else if (!strcmp(argv[i], "--certverify") && i + 1 < argc) {
            certverify = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--cafile") && i + 1 < argc) {
            cafile = argv[++i];
        } else if (!strcmp(argv[i], "--cainter") && i + 1 < argc) {
            cainter = argv[++i];
        } else if (!strcmp(argv[i], "--expire") && i + 1 < argc) {
            expire = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--timeout") && i + 1 < argc) {
            timeout = atoi(argv[++i]);
        } else {
            fprintf(stderr, "driver: unknown/incomplete arg: %s\n", argv[i]);
            usage(argv[0]);
            return 2;
        }
    }

    if (!identity_file || certverify < 0) {
        usage(argv[0]);
        return 2;
    }

    char *identity = slurp(identity_file);
    if (!identity) {
        fprintf(stderr, "driver: cannot read identity file: %s\n",
                identity_file);
        return 2;
    }

    /*
     * Configure the exact libopt knobs the Kamailio modparams set. Order and
     * names are identical to secsipid_mod.c's handling of `libopt "name=value"`.
     * SecSIPIDOptSet* return 0 on success; we log but do not hard-fail on a
     * non-zero (older libs tolerate unknown opts), because the verify result is
     * the real signal.
     */
    int rc;
    rc = SecSIPIDOptSetN("CertVerify", certverify);
    fprintf(stderr, "driver: SecSIPIDOptSetN(CertVerify=%d) -> %d\n",
            certverify, rc);

    if (cafile && cafile[0]) {
        rc = SecSIPIDOptSetS("CertCAFile", (char *)cafile);
        fprintf(stderr, "driver: SecSIPIDOptSetS(CertCAFile=%s) -> %d\n",
                cafile, rc);
    }
    if (cainter && cainter[0]) {
        rc = SecSIPIDOptSetS("CertCAInter", (char *)cainter);
        fprintf(stderr, "driver: SecSIPIDOptSetS(CertCAInter=%s) -> %d\n",
                cainter, rc);
    }

    /*
     * The verify. Pass the true identity length, the iat window (expire), a NULL
     * pubkey path (=> libsecsipid resolves the leaf via the PASSporT x5u/info=),
     * and the fetch timeout — byte-for-byte how secsipid_mod.c calls it when
     * secsipid_check_identity("") runs with an empty keyPath.
     */
    int idlen = (int)strlen(identity);
    int vr = SecSIPIDCheckFull(identity, idlen, expire, NULL, timeout);
    fprintf(stderr,
            "driver: SecSIPIDCheckFull(len=%d, expire=%d, timeout=%d) -> %d  (%s)\n",
            idlen, expire, timeout, vr, vr == 0 ? "PASS/valid" : "FAIL/invalid");

    free(identity);

    /* 0 == valid PASSporT (and trusted chain if CertVerify>0). */
    return (vr == 0) ? 0 : 1;
}
