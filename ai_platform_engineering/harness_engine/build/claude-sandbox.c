/* A fail-closed, unprivileged boundary for the entire CLI ACP process tree.
 * Linux Landlock ABI 6, plus an additional seccomp filter; no namespaces.
 * No credentials or untrusted policy are read by this launcher.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/prctl.h>
#include <seccomp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Stable UAPI layout, including fields absent from Debian 12's headers. */
struct ruleset { uint64_t fs, net, scoped; };
struct path_rule { uint64_t access; int32_t fd; } __attribute__((packed));
struct port_rule { uint64_t access, port; };
static const uint64_t read_access = (1ULL << 0) | (1ULL << 2) | (1ULL << 3);
static const uint64_t all_fs = (1ULL << 16) - 1;

static void fail(const char *reason) {
    fprintf(stderr, "Claude isolation refused: %s\n", reason);
    exit(125);
}

static void allow_path(int rules, const char *path, uint64_t access, int optional) {
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
        if (optional && errno == ENOENT) return;
        fail("required runtime path is unavailable");
    }
    struct stat st;
    if (fstat(fd, &st)) fail("cannot inspect runtime path");
    if (!S_ISDIR(st.st_mode)) access &= (1ULL << 0) | (1ULL << 1) | (1ULL << 2) | (1ULL << 14) | (1ULL << 15);
    struct path_rule rule = { .access = access, .fd = fd };
    if (syscall(SYS_landlock_add_rule, rules, 1, &rule, 0)) fail("cannot install filesystem policy");
    close(fd);
}

static void deny_syscall(scmp_filter_ctx filter, const char *name) {
    int nr = seccomp_syscall_resolve_name(name);
    if (nr != __NR_SCMP_ERROR && seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), nr, 0))
        fail("cannot install syscall policy");
}

static void restrict_syscalls(void) {
    scmp_filter_ctx filter = seccomp_init(SCMP_ACT_ALLOW);
    if (!filter) fail("cannot create syscall policy");
    /* libseccomp rejects non-native syscall architectures (including x32).
     * Keep descendants in the worker's process group for confirmed teardown.
     * socketpair remains usable for private parent/child IPC, not external IPC.
     */
    const char *denied[] = {
        "ptrace", "process_vm_readv", "process_vm_writev", "pidfd_open", "pidfd_getfd", "pidfd_send_signal",
        "io_uring_setup", "io_uring_enter", "io_uring_register", "perf_event_open", "bpf",
        "keyctl", "add_key", "request_key", "mount", "umount2", "pivot_root", "chroot",
        "fsopen", "fsconfig", "fsmount", "move_mount", "open_tree", "mount_setattr",
        "unshare", "setns", "setsid", "setpgid", "setpriority", "sched_setparam", "sched_setscheduler",
        "msgget", "msgsnd", "msgrcv", "msgctl", "semget", "semop", "semtimedop", "semctl",
        "shmget", "shmat", "shmdt", "shmctl", NULL
    };
    for (int i = 0; denied[i]; i++) deny_syscall(filter, denied[i]);
    /* No UDP, raw sockets, pathname/abstract Unix sockets or alternative families.
     * Landlock then limits TCP connect ports and denies every TCP bind.
     */
    for (unsigned family = 0; family < AF_INET6; family++) {
        if (family != AF_INET && seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1,
                                                SCMP_A0(SCMP_CMP_EQ, family)))
            fail("cannot install socket family policy");
    }
    if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1, SCMP_A0(SCMP_CMP_GT, AF_INET6)))
        fail("cannot install socket family policy");
    for (unsigned type = 0; type < 16; type++) {
        if (type != SOCK_STREAM && seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1,
                                                  SCMP_A1(SCMP_CMP_MASKED_EQ, 0xf, type)))
            fail("cannot install socket type policy");
    }
    /* Stream sockets must use TCP, never SCTP or another port-policy bypass. */
    for (unsigned protocol = 1; protocol < 6; protocol++) {
        if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1,
                             SCMP_A2(SCMP_CMP_EQ, protocol))) fail("cannot install protocol policy");
    }
    if (seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1, SCMP_A2(SCMP_CMP_GT, 6)))
        fail("cannot install protocol policy");
    if (seccomp_load(filter)) fail("cannot enforce syscall policy");
    seccomp_release(filter);
}

int main(int argc, char **argv) {
    if (geteuid() == 0) fail("run the worker as non-root");
    int check = argc == 2 && strcmp(argv[1], "--check") == 0;
    if (!check && (argc < 6 || strcmp(argv[1], "--workspace"))) fail("invalid launcher arguments");
    if (syscall(SYS_landlock_create_ruleset, NULL, 0, 1) < 6)
        fail("Linux Landlock ABI 6 or newer is required");
    struct ruleset policy = { .fs = all_fs, .net = 3, .scoped = 3 };
    int rules = syscall(SYS_landlock_create_ruleset, &policy, sizeof(policy), 0);
    if (rules < 0) fail("cannot create Landlock policy");
    int command = 0;
    if (!check) {
        char resolved[PATH_MAX];
        if (!realpath(argv[2], resolved) || strcmp(resolved, argv[2]) || strcmp(resolved, "/") == 0)
            fail("workspace must be a canonical private directory");
        const char *readonly[] = { "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt/claude-cli",
                                  "/app/.venv", "/app/src", NULL };
        const char *forbidden[] = { "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/app",
                                   "/etc", "/proc", "/sys", "/dev", NULL };
        for (int i = 0; forbidden[i]; i++) {
            size_t len = strlen(forbidden[i]);
            if (!strncmp(resolved, forbidden[i], len) && (resolved[len] == '/' || resolved[len] == '\0'))
                fail("workspace overlaps protected runtime paths");
        }
        struct stat st;
        if (stat(resolved, &st) || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 077))
            fail("workspace must be owned by the worker with mode 0700");
        /* Do not allow device creation, Unix sockets, or device ioctls in a workspace. */
        allow_path(rules, resolved, all_fs & ~((1ULL << 6) | (1ULL << 9) | (1ULL << 11) | (1ULL << 15)), 0);
        for (int i = 0; readonly[i]; i++) allow_path(rules, readonly[i], read_access, 1);
        const char *files[] = { "/etc/ld.so.cache", "/etc/ssl/certs", "/etc/pki/tls/certs",
                               "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/hosts",
                               "/proc/cpuinfo", "/proc/meminfo", "/dev/urandom", "/dev/random", NULL };
        for (int i = 0; files[i]; i++) allow_path(rules, files[i], read_access & ~(1ULL << 0), 1);
        allow_path(rules, "/dev/null", (1ULL << 1) | (1ULL << 2), 0);
        for (int i = 3; i < argc; i++) {
            if (!strcmp(argv[i], "--")) { command = i + 1; break; }
            if (strcmp(argv[i], "--connect-port") || ++i >= argc) fail("invalid port policy");
            char *end;
            unsigned long port = strtoul(argv[i], &end, 10);
            if (*end || port == 0 || port > 65535) fail("invalid allowed port");
            struct port_rule rule = { .access = 2, .port = port };
            if (syscall(SYS_landlock_add_rule, rules, 2, &rule, 0)) fail("cannot install network policy");
        }
        if (!command || command >= argc) fail("missing command");
        if (chdir(resolved)) fail("cannot enter workspace");
    }
    struct rlimit no_core = {0, 0};
    if (setrlimit(RLIMIT_CORE, &no_core) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0))
        fail("cannot disable privilege escalation or core dumps");
    if (syscall(SYS_landlock_restrict_self, rules, 0)) fail("cannot enforce Landlock policy");
    /* No pre-opened descriptors may bypass the filesystem policy. */
    if (syscall(SYS_close_range, 3U, ~0U, 0)) fail("cannot close inherited descriptors");
    restrict_syscalls();
    if (check) return 0;
    execvp(argv[command], &argv[command]);
    fail("cannot execute the configured ACP command");
}
