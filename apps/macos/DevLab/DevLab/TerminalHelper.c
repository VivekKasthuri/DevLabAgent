#include "TerminalHelper.h"
#include <util.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <signal.h>

pid_t pty_spawn(int *master_fd, int cols, int rows, const char *cwd) {
    struct winsize ws = {
        .ws_row    = (unsigned short)rows,
        .ws_col    = (unsigned short)cols,
        .ws_xpixel = 0,
        .ws_ypixel = 0
    };

    pid_t pid = forkpty(master_fd, NULL, NULL, &ws);

    if (pid == 0) {
        // ── Child ────────────────────────────────────────────────────────────
        if (cwd && *cwd) chdir(cwd);

        setenv("TERM",      "xterm-256color", 1);
        setenv("COLORTERM", "truecolor",       1);
        setenv("LANG",      "en_US.UTF-8",     1);

        const char *shell = getenv("SHELL");
        if (!shell || !*shell) shell = "/bin/zsh";
        execl(shell, shell, "-l", (char *)NULL);
        _exit(1);
    }

    return pid;
}

void pty_resize(int master_fd, int cols, int rows) {
    struct winsize ws = {
        .ws_row    = (unsigned short)rows,
        .ws_col    = (unsigned short)cols,
        .ws_xpixel = 0,
        .ws_ypixel = 0
    };
    ioctl(master_fd, TIOCSWINSZ, &ws);
}
