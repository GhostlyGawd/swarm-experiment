/* A bounded, credential-checking AF_UNIX gateway for the witness service.
 * This process has no witness HMAC key and does not interpret signed JSON.
 * It intentionally serves one exchange at a time; see the research README.
 */
#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>
#include <time.h>
#include <unistd.h>

#define MAX_FRAME (36u * 1024u * 1024u)
#define DEFAULT_TIMEOUT_MS 5000u

struct config {
    const char *listen_path;
    const char *upstream_path;
    uid_t client_uid;
    gid_t client_gid;
    uid_t upstream_uid;
    mode_t socket_mode;
    unsigned timeout_ms;
    int check_gid;
};

static volatile sig_atomic_t stopping;

static void stop_handler(int signo) { (void)signo; stopping = 1; }

static void usage(void) {
    fputs("usage: witness-peer --listen /absolute/socket --upstream /absolute/socket "
          "--uid N [--gid N] [--upstream-uid N] [--mode 0600|0660] "
          "[--timeout-ms 1..60000]\n", stderr);
}

static int decimal_id(const char *s, unsigned *out) {
    char *end;
    unsigned long long n;
    if (!s || !*s || *s == '-' || *s == '+') return -1;
    errno = 0;
    n = strtoull(s, &end, 10);
    if (errno || *end || n > UINT_MAX) return -1;
    *out = (unsigned)n;
    return 0;
}

static int args(int argc, char **argv, struct config *cfg) {
    int seen = 0;
    unsigned n;
    memset(cfg, 0, sizeof(*cfg));
    cfg->socket_mode = 0600;
    cfg->timeout_ms = DEFAULT_TIMEOUT_MS;
    cfg->upstream_uid = geteuid();
    for (int i = 1; i < argc; i += 2) {
        if (i + 1 >= argc) return -1;
        if (!strcmp(argv[i], "--listen") && !(seen & 1)) {
            cfg->listen_path = argv[i + 1]; seen |= 1;
        } else if (!strcmp(argv[i], "--upstream") && !(seen & 2)) {
            cfg->upstream_path = argv[i + 1]; seen |= 2;
        } else if (!strcmp(argv[i], "--uid") && !(seen & 4)) {
            if (decimal_id(argv[i + 1], &n)) return -1;
            cfg->client_uid = (uid_t)n; seen |= 4;
        } else if (!strcmp(argv[i], "--gid") && !(seen & 8)) {
            if (decimal_id(argv[i + 1], &n)) return -1;
            cfg->client_gid = (gid_t)n; cfg->check_gid = 1; seen |= 8;
        } else if (!strcmp(argv[i], "--upstream-uid") && !(seen & 16)) {
            if (decimal_id(argv[i + 1], &n)) return -1;
            cfg->upstream_uid = (uid_t)n; seen |= 16;
        } else if (!strcmp(argv[i], "--mode") && !(seen & 32)) {
            if (strcmp(argv[i + 1], "0600") && strcmp(argv[i + 1], "0660")) return -1;
            cfg->socket_mode = (mode_t)strtoul(argv[i + 1], NULL, 8); seen |= 32;
        } else if (!strcmp(argv[i], "--timeout-ms") && !(seen & 64)) {
            if (decimal_id(argv[i + 1], &n) || !n || n > 60000) return -1;
            cfg->timeout_ms = n; seen |= 64;
        } else return -1;
    }
    return (seen & 7) == 7 ? 0 : -1;
}

static int address(const char *path, struct sockaddr_un *addr, socklen_t *len) {
    size_t n;
    if (!path || path[0] != '/' || (n = strlen(path)) >= sizeof(addr->sun_path)) return -1;
    memset(addr, 0, sizeof(*addr));
    addr->sun_family = AF_UNIX;
    memcpy(addr->sun_path, path, n + 1);
    *len = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + n + 1);
    return 0;
}

static int private_parent(const char *path) {
    char *copy = strdup(path);
    char *slash;
    struct stat st;
    int ok;
    if (!copy) return -1;
    slash = strrchr(copy, '/');
    if (!slash) { free(copy); return -1; }
    if (slash == copy) slash[1] = '\0'; else *slash = '\0';
    ok = lstat(copy, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == geteuid()
        && !(st.st_mode & 0022);
    free(copy);
    return ok ? 0 : -1;
}

static int nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0 ? -1 : 0;
}

static int64_t now_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) return -1;
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int ready(int fd, short events, int64_t deadline) {
    struct pollfd pfd = { .fd = fd, .events = events };
    for (;;) {
        int64_t now = now_ms();
        if (now < 0 || now >= deadline) return -1;
        int left = (int)(deadline - now);
        int result = poll(&pfd, 1, left);
        if (result > 0) return pfd.revents & (events | POLLHUP) ? 0 : -1;
        if (result == 0) return -1;
        if (errno != EINTR) return -1;
    }
}

static int read_exact(int fd, unsigned char *buf, size_t n, int64_t deadline) {
    size_t pos = 0;
    while (pos < n) {
        if (ready(fd, POLLIN, deadline)) return -1;
        ssize_t got = read(fd, buf + pos, n - pos);
        if (got > 0) pos += (size_t)got;
        else if (got == 0) return -1;
        else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return -1;
    }
    return 0;
}

static int exact_eof(int fd, int64_t deadline) {
    unsigned char extra;
    for (;;) {
        if (ready(fd, POLLIN, deadline)) return -1;
        ssize_t got = read(fd, &extra, 1);
        if (got == 0) return 0;
        if (got > 0) return -1;
        if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return -1;
    }
}

static int read_frame(int fd, unsigned char *buf, size_t *size, int64_t deadline) {
    uint32_t n;
    if (read_exact(fd, buf, 4, deadline)) return -1;
    n = ((uint32_t)buf[0] << 24) | ((uint32_t)buf[1] << 16)
        | ((uint32_t)buf[2] << 8) | buf[3];
    if (n == 0 || n > MAX_FRAME || read_exact(fd, buf + 4, n, deadline)
        || exact_eof(fd, deadline)) return -1;
    *size = (size_t)n + 4;
    return 0;
}

static int write_exact(int fd, const unsigned char *buf, size_t n, int64_t deadline) {
    size_t pos = 0;
    while (pos < n) {
        if (ready(fd, POLLOUT, deadline)) return -1;
        ssize_t wrote = write(fd, buf + pos, n - pos);
        if (wrote > 0) pos += (size_t)wrote;
        else if (wrote == 0) return -1;
        else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return -1;
    }
    return 0;
}

static int peer_ids(int fd, uid_t *uid, gid_t *gid) {
#if defined(__APPLE__)
    return getpeereid(fd, uid, gid);
#elif defined(__linux__)
    struct ucred cred;
    socklen_t len = sizeof(cred);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) || len != sizeof(cred)) return -1;
    *uid = cred.uid; *gid = cred.gid;
    return 0;
#else
#error "witness-peer supports macOS and Linux peer credentials only"
#endif
}

static int upstream_connect(const struct config *cfg, int64_t deadline) {
    struct sockaddr_un addr;
    socklen_t len;
    uid_t uid;
    gid_t gid;
    int fd, result, err = 0;
    socklen_t err_len = sizeof(err);
    if (address(cfg->upstream_path, &addr, &len)) return -1;
    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    if (nonblocking(fd)) goto fail;
    result = connect(fd, (struct sockaddr *)&addr, len);
    if (result && errno != EINPROGRESS) goto fail;
    if (result && (ready(fd, POLLOUT, deadline)
        || getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &err_len) || err)) goto fail;
    if (peer_ids(fd, &uid, &gid) || uid != cfg->upstream_uid) goto fail;
    return fd;
fail:
    close(fd);
    return -1;
}

static int exchange(int client, const struct config *cfg, unsigned char *buf) {
    uid_t uid;
    gid_t gid;
    int upstream = -1, ok = -1;
    size_t size;
    int64_t start = now_ms(), deadline;
    if (start < 0 || start > INT64_MAX - cfg->timeout_ms) return -1;
    deadline = start + cfg->timeout_ms;
    /* No request bytes or upstream connection before admission. */
    if (peer_ids(client, &uid, &gid) || uid != cfg->client_uid
        || (cfg->check_gid && gid != cfg->client_gid)) return -1;
    if (nonblocking(client) || read_frame(client, buf, &size, deadline)) return -1;
    upstream = upstream_connect(cfg, deadline);
    if (upstream < 0) return -1;
    if (write_exact(upstream, buf, size, deadline) || shutdown(upstream, SHUT_WR)
        || read_frame(upstream, buf, &size, deadline)
        || write_exact(client, buf, size, deadline)
        || shutdown(client, SHUT_WR)) goto done;
    ok = 0;
done:
    close(upstream);
    return ok;
}

int main(int argc, char **argv) {
    struct config cfg;
    struct sockaddr_un addr;
    struct stat original = {0}, current;
    socklen_t len;
    int listener = -1, result = 1, owned_path = 0;
    unsigned char *buf = NULL;
    struct sigaction action = {0};
    if (args(argc, argv, &cfg) || address(cfg.listen_path, &addr, &len)
        || address(cfg.upstream_path, &addr, &len)
        || !strcmp(cfg.listen_path, cfg.upstream_path)
        || private_parent(cfg.listen_path)) {
        usage(); return 2;
    }
    if (lstat(cfg.listen_path, &current) == 0 || errno != ENOENT) {
        fputs("witness-peer: listen path already exists\n", stderr); return 2;
    }
    if (address(cfg.listen_path, &addr, &len)) return 2;
    action.sa_handler = stop_handler;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);
    signal(SIGPIPE, SIG_IGN);
    listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0) goto done;
    mode_t old_mask = umask(0077);
    int bound = bind(listener, (struct sockaddr *)&addr, len);
    umask(old_mask);
    if (bound) goto done;
    if (lstat(cfg.listen_path, &original) || !S_ISSOCK(original.st_mode)) goto done;
    owned_path = 1;
    if (chmod(cfg.listen_path, cfg.socket_mode)
        || listen(listener, 8)) goto done;
    buf = malloc((size_t)MAX_FRAME + 4);
    if (!buf) goto done;
    puts("witness-peer ready");
    fflush(stdout);
    while (!stopping) {
        int client = accept(listener, NULL, NULL);
        if (client >= 0) {
            (void)exchange(client, &cfg, buf);
            close(client);
        } else if (errno != EINTR) goto done;
    }
    result = 0;
done:
    if (listener >= 0) close(listener);
    if (buf) free(buf);
    if (owned_path && lstat(cfg.listen_path, &current) == 0 && S_ISSOCK(current.st_mode)
        && current.st_dev == original.st_dev && current.st_ino == original.st_ino)
        unlink(cfg.listen_path);
    if (result) fputs("witness-peer: startup or accept failed\n", stderr);
    return result;
}
