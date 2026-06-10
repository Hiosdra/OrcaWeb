#pragma once

namespace tbb {

// Single-threaded WASM — mutexes are no-ops.
struct spin_mutex {
    spin_mutex() = default;
    spin_mutex(const spin_mutex&) = delete;
    spin_mutex& operator=(const spin_mutex&) = delete;

    void lock()         {}
    void unlock()       {}
    bool try_lock()     { return true; }

    struct scoped_lock {
        scoped_lock()               = default;
        explicit scoped_lock(spin_mutex&) {}
        void acquire(spin_mutex&)   {}
        bool try_acquire(spin_mutex&) { return true; }
        void release()              {}
    };
};

using spin_rw_mutex = spin_mutex;
using queuing_mutex = spin_mutex;
using mutex         = spin_mutex;
using recursive_mutex = spin_mutex;

} // namespace tbb
