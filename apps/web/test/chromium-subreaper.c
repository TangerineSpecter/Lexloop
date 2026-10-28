#define _GNU_SOURCE

#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stop_signal = 0;
static pid_t browser_group = -1;

static void forward_signal(int signal_number) {
  stop_signal = signal_number;
  if (browser_group > 1) kill(-browser_group, signal_number);
}

static long milliseconds_since(const struct timespec *start) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (now.tv_sec - start->tv_sec) * 1000L +
         (now.tv_nsec - start->tv_nsec) / 1000000L;
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) return 125;

  struct sigaction action = {0};
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 ||
      sigaction(SIGINT, &action, NULL) != 0) {
    return 125;
  }

  pid_t browser = fork();
  if (browser < 0) return 125;
  if (browser == 0) {
    setpgid(0, 0);
    execvp(argv[1], &argv[1]);
    _exit(errno == ENOENT ? 127 : 126);
  }

  browser_group = browser;
  setpgid(browser, browser);
  if (stop_signal) kill(-browser_group, stop_signal);

  int browser_status = 0;
  bool browser_reaped = false;
  bool escalated = false;
  struct timespec signal_started = {0};

  for (;;) {
    int status;
    pid_t child = waitpid(-1, &status, WNOHANG);
    if (child > 0) {
      if (child == browser) {
        browser_status = status;
        browser_reaped = true;
      }
      continue;
    }
    if (child < 0) {
      if (errno == EINTR) continue;
      if (errno == ECHILD) break;
      return 125;
    }

    if (stop_signal && signal_started.tv_sec == 0 && signal_started.tv_nsec == 0)
      clock_gettime(CLOCK_MONOTONIC, &signal_started);

    if (stop_signal && !escalated &&
        milliseconds_since(&signal_started) >= 1500L) {
      if (browser_group > 1) kill(-browser_group, SIGKILL);
      escalated = true;
    }

    struct timespec pause = {.tv_sec = 0, .tv_nsec = 20 * 1000 * 1000};
    nanosleep(&pause, NULL);
  }

  if (!browser_reaped) return 125;
  if (WIFEXITED(browser_status)) return WEXITSTATUS(browser_status);
  if (WIFSIGNALED(browser_status)) return 128 + WTERMSIG(browser_status);
  return 125;
}
