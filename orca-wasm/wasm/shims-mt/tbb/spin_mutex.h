#pragma once
// Real synchronization primitives for shims-mt/. The sequential shims/
// version's no-op lock()/unlock() is correct only under the guarantee that
// nothing actually runs concurrently — that guarantee no longer holds here,
// so this file is the highest-risk one to get right (see MT-PLAN.md Phase 1e).
#include <atomic>
#include <mutex>
#include <thread>

namespace tbb {

// TBB's spin_mutex API: lock()/unlock()/try_lock() plus a scoped_lock helper
// with acquire()/try_acquire()/release(). Implemented as a spinlock with a
// bounded busy-wait before yielding, matching the "spin" name and TBB's
// intended use (briefly-held critical sections around small updates, not
// long operations).
class spin_mutex {
public:
    spin_mutex() = default;
    spin_mutex(const spin_mutex&) = delete;
    spin_mutex& operator=(const spin_mutex&) = delete;

    void lock() {
        int spins = 0;
        while (m_flag.test_and_set(std::memory_order_acquire)) {
            if (++spins > 64) {
                std::this_thread::yield();
                spins = 0;
            }
        }
    }
    void unlock() { m_flag.clear(std::memory_order_release); }
    bool try_lock() { return !m_flag.test_and_set(std::memory_order_acquire); }

    class scoped_lock {
    public:
        scoped_lock() = default;
        explicit scoped_lock(spin_mutex& m) : m_mutex(&m) { m_mutex->lock(); }
        ~scoped_lock() { release(); }
        scoped_lock(const scoped_lock&) = delete;
        scoped_lock& operator=(const scoped_lock&) = delete;

        void acquire(spin_mutex& m) {
            m_mutex = &m;
            m_mutex->lock();
        }
        bool try_acquire(spin_mutex& m) {
            if (m.try_lock()) {
                m_mutex = &m;
                return true;
            }
            return false;
        }
        void release() {
            if (m_mutex) {
                m_mutex->unlock();
                m_mutex = nullptr;
            }
        }

    private:
        spin_mutex* m_mutex = nullptr;
    };

private:
    std::atomic_flag m_flag = ATOMIC_FLAG_INIT;
};

// TBB scoped_lock-compatible wrapper over std::mutex, for the aliases below —
// a real rw-mutex/queuing-mutex is out of scope for v1 (see MT-PLAN.md
// "Explicitly out of scope"); these are correct but not fair/optimized.
template <typename Underlying>
class basic_mutex {
public:
    basic_mutex() = default;
    basic_mutex(const basic_mutex&) = delete;
    basic_mutex& operator=(const basic_mutex&) = delete;

    void lock() { m_impl.lock(); }
    void unlock() { m_impl.unlock(); }
    bool try_lock() { return m_impl.try_lock(); }

    class scoped_lock {
    public:
        scoped_lock() = default;
        explicit scoped_lock(basic_mutex& m) : m_mutex(&m) { m_mutex->lock(); }
        ~scoped_lock() { release(); }
        scoped_lock(const scoped_lock&) = delete;
        scoped_lock& operator=(const scoped_lock&) = delete;

        void acquire(basic_mutex& m) {
            m_mutex = &m;
            m_mutex->lock();
        }
        bool try_acquire(basic_mutex& m) {
            if (m.try_lock()) {
                m_mutex = &m;
                return true;
            }
            return false;
        }
        void release() {
            if (m_mutex) {
                m_mutex->unlock();
                m_mutex = nullptr;
            }
        }

    private:
        basic_mutex* m_mutex = nullptr;
    };

private:
    Underlying m_impl;
};

using spin_rw_mutex   = spin_mutex;               // no reader/writer distinction in v1
using queuing_mutex   = basic_mutex<std::mutex>;  // no FIFO fairness guarantee in v1
using mutex           = basic_mutex<std::mutex>;
using recursive_mutex = basic_mutex<std::recursive_mutex>;

} // namespace tbb
