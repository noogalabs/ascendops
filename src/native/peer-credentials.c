#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#ifdef __APPLE__
#include <libproc.h>
#include <sys/un.h>
#endif

static void fail(const char *operation) {
  fprintf(stderr, "%s: %s\n", operation, strerror(errno));
  exit(2);
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--process-start") == 0) {
    char *end = NULL;
    long requested = strtol(argv[2], &end, 10);
    if (!end || *end != '\0' || requested <= 0) {
      fprintf(stderr, "invalid pid\n");
      return 3;
    }
#ifdef __APPLE__
    struct proc_bsdinfo requested_info;
    int requested_bytes = proc_pidinfo((pid_t)requested, PROC_PIDTBSDINFO, 0, &requested_info, sizeof(requested_info));
    if (requested_bytes != sizeof(requested_info)) {
      if (requested_bytes >= 0) errno = ESRCH;
      fail("proc_pidinfo");
    }
    printf(
      "{\"platform\":\"darwin\",\"pid\":%ld,\"startSeconds\":%llu,\"startMicroseconds\":%llu}\n",
      requested,
      (unsigned long long)requested_info.pbi_start_tvsec,
      (unsigned long long)requested_info.pbi_start_tvusec
    );
#elif defined(__linux__)
    printf("{\"platform\":\"linux\",\"pid\":%ld}\n", requested);
#else
    fprintf(stderr, "unsupported platform\n");
    return 3;
#endif
    return 0;
  }
#ifdef __APPLE__
  if (argc == 3 && strcmp(argv[1], "--full-fsync") == 0) {
    int file_fd = open(argv[2], O_RDWR);
    if (file_fd < 0) fail("open-full-fsync");
    if (fcntl(file_fd, F_FULLFSYNC) != 0) {
      int saved = errno;
      close(file_fd);
      errno = saved;
      fail("F_FULLFSYNC");
    }
    if (close(file_fd) != 0) fail("close-full-fsync");
    return 0;
  }
#endif
  const int socket_fd = 3;
#ifdef __linux__
  struct ucred credentials;
  socklen_t length = sizeof(credentials);
  if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0) {
    fail("SO_PEERCRED");
  }
  printf("{\"platform\":\"linux\",\"pid\":%ld}\n", (long)credentials.pid);
#elif defined(__APPLE__)
  pid_t peer_pid = 0;
  socklen_t length = sizeof(peer_pid);
  if (getsockopt(socket_fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &length) != 0) {
    fail("LOCAL_PEERPID");
  }
  struct proc_bsdinfo info;
  int bytes = proc_pidinfo(peer_pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes != sizeof(info)) {
    if (bytes >= 0) errno = ESRCH;
    fail("proc_pidinfo");
  }
  printf(
    "{\"platform\":\"darwin\",\"pid\":%ld,\"startSeconds\":%llu,\"startMicroseconds\":%llu}\n",
    (long)peer_pid,
    (unsigned long long)info.pbi_start_tvsec,
    (unsigned long long)info.pbi_start_tvusec
  );
#else
  fprintf(stderr, "unsupported platform\n");
  return 3;
#endif
  return 0;
}
