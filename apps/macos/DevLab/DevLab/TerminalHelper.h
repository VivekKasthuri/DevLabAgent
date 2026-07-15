#ifndef TerminalHelper_h
#define TerminalHelper_h

#include <sys/types.h>
#include <stdint.h>

/// Fork a child shell with a PTY. Returns child PID in parent, 0 in child.
/// master_fd is set to the master side of the PTY.
pid_t pty_spawn(int *master_fd, int cols, int rows, const char *cwd);

/// Resize the PTY window.
void pty_resize(int master_fd, int cols, int rows);

#endif /* TerminalHelper_h */
