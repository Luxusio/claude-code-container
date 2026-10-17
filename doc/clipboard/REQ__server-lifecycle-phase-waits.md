# Clipboard server startup phases and health requests

Contention for the startup lock retains its 13500 ms allowance; fresh daemon
publication retains its separate 5000 ms allowance. Each deadline uses the
existing monotonic clock port. Polling sleeps are at most 100 ms and the current
remainder. Expired phases start no publication/health polling and accept no
late healthy result. A changed token and authenticated current version are
still required. Recheck elapsed time after polling work before another attempt.

Successful lock acquisition retains its held-lock flow. Initial bridge reuse,
held-lock health, the 3500 ms recovery/upgrade grace, bind-user deferral, shutdown
acknowledgement, partial-child retention and release/exception order stay intact.

Native health requests keep their separate 2000 ms timeout and authenticated
GET. Each owned request settles once and clears its timer. Timeout, request error,
response abort or error destroys unfinished request work; late events cannot
publish success. Successful completed responses need no forced destruction.
Synchronous request construction/end errors keep their original rejection after
cleanup, including when cleanup throws. Cleanup cannot affect other requests.

These limits govern dispatch, acceptance and owned request cleanup. They do not
cancel all previously dispatched work or guarantee hard real-time completion.
Actual application/facade tests cover split clocks, boundary overruns, request
settlement and unchanged lock policy; fixtures are not native OS acceptance.
