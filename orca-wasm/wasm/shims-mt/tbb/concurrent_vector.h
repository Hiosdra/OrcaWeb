#pragma once
#include <mutex>
#include <vector>
#include <memory>

namespace tbb {

// See orca-wasm/MT-PLAN.md Phase 0/1e: real libslic3r call sites either (a)
// pre-size then write via indexed assignment on disjoint indices — already
// race-free with plain std::vector, no locking needed — or (b) genuinely
// push_back/emplace_back concurrently from multiple parallel_for chunks, and
// none of those hold a reference/iterator into the vector across another
// thread's concurrent append. A mutex around the mutating operations is
// therefore sufficient; the non-reallocating TBB-exact "stable references
// under growth" guarantee is deliberately not implemented (see MT-PLAN.md
// "Explicitly out of scope").
//
// Only mutating operations that can reallocate/append take the lock.
// operator[]/begin/end/size are left unguarded, same as std::vector's normal
// contract: concurrent reads are fine, and concurrent writes to *disjoint*
// indices (the indexed-assignment call sites above) are fine without a lock.
template<typename T, typename Allocator = std::allocator<T>>
class concurrent_vector : public std::vector<T, Allocator> {
    using Base = std::vector<T, Allocator>;
public:
    using Base::Base;
    // std::mutex is non-copyable/non-movable, so the implicit copy/move
    // members would otherwise be deleted — each instance gets its own fresh
    // mutex; the vector *contents* still copy/move normally via Base.
    concurrent_vector() = default;
    concurrent_vector(const concurrent_vector& other) {
        std::lock_guard<std::mutex> lk(other.m_mutex);
        Base::operator=(static_cast<const Base&>(other));
    }
    concurrent_vector(concurrent_vector&& other) {
        std::lock_guard<std::mutex> lk(other.m_mutex);
        Base::operator=(std::move(static_cast<Base&>(other)));
    }
    concurrent_vector& operator=(const concurrent_vector& other) {
        if (this == &other) return *this;
        std::scoped_lock lk(m_mutex, other.m_mutex);
        Base::operator=(static_cast<const Base&>(other));
        return *this;
    }
    concurrent_vector& operator=(concurrent_vector&& other) {
        if (this == &other) return *this;
        std::scoped_lock lk(m_mutex, other.m_mutex);
        Base::operator=(std::move(static_cast<Base&>(other)));
        return *this;
    }

    using iterator       = typename Base::iterator;
    using const_iterator = typename Base::const_iterator;
    using size_type      = typename Base::size_type;
    using reference      = typename Base::reference;

    iterator grow_by(size_type n) {
        std::lock_guard<std::mutex> lk(m_mutex);
        size_type old_size = this->size();
        this->resize(old_size + n);
        return this->begin() + static_cast<std::ptrdiff_t>(old_size);
    }
    iterator grow_by(size_type n, const T& val) {
        std::lock_guard<std::mutex> lk(m_mutex);
        size_type old_size = this->size();
        this->resize(old_size + n, val);
        return this->begin() + static_cast<std::ptrdiff_t>(old_size);
    }
    iterator grow_to_at_least(size_type n) {
        std::lock_guard<std::mutex> lk(m_mutex);
        if (this->size() < n) this->resize(n);
        return this->begin();
    }

    // TBB concurrent_vector::push_back returns a reference, not void.
    // NOTE: unlike real TBB, that reference may be invalidated by a later
    // concurrent push_back from another thread (see the file header) — safe
    // for every verified call site, which only reads back after all
    // concurrent writers have finished.
    reference push_back(const T& val) {
        std::lock_guard<std::mutex> lk(m_mutex);
        Base::push_back(val);
        return this->back();
    }
    reference push_back(T&& val) {
        std::lock_guard<std::mutex> lk(m_mutex);
        Base::push_back(std::move(val));
        return this->back();
    }
    template <typename... Args>
    reference emplace_back(Args&&... args) {
        std::lock_guard<std::mutex> lk(m_mutex);
        Base::emplace_back(std::forward<Args>(args)...);
        return this->back();
    }

private:
    mutable std::mutex m_mutex;
};

} // namespace tbb
