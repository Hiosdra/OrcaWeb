#pragma once
#include <mutex>
#include <unordered_set>
#include <utility>

namespace tbb {

// Real libslic3r usage (MT-PLAN.md Phase 0, PrintObject.cpp) is only
// count()/insert() (no held iterators across the lock boundary), so — unlike
// concurrent_unordered_map.h — there's no iterator-invalidation hazard here:
// every mutating/query operation is self-contained under the lock.
template<typename Key, typename Hash = std::hash<Key>,
         typename KeyEqual = std::equal_to<Key>,
         typename Allocator = std::allocator<Key>>
class concurrent_unordered_set {
    using Base = std::unordered_set<Key, Hash, KeyEqual, Allocator>;
public:
    using iterator       = typename Base::iterator;
    using const_iterator = typename Base::const_iterator;
    using size_type      = typename Base::size_type;

    concurrent_unordered_set() = default;
    concurrent_unordered_set(const concurrent_unordered_set& other) : m_set(other.m_set) {}
    concurrent_unordered_set(concurrent_unordered_set&& other) noexcept
        : m_set(std::move(other.m_set)) {}
    concurrent_unordered_set& operator=(const concurrent_unordered_set& other) {
        std::lock_guard<std::mutex> lk(m_mutex);
        m_set = other.m_set;
        return *this;
    }
    concurrent_unordered_set& operator=(concurrent_unordered_set&& other) noexcept {
        std::lock_guard<std::mutex> lk(m_mutex);
        m_set = std::move(other.m_set);
        return *this;
    }

    std::pair<iterator, bool> insert(const Key& key) {
        std::lock_guard<std::mutex> lk(m_mutex);
        return m_set.insert(key);
    }
    std::pair<iterator, bool> insert(Key&& key) {
        std::lock_guard<std::mutex> lk(m_mutex);
        return m_set.insert(std::move(key));
    }
    size_type count(const Key& key) const {
        std::lock_guard<std::mutex> lk(m_mutex);
        return m_set.count(key);
    }
    size_type size() const {
        std::lock_guard<std::mutex> lk(m_mutex);
        return m_set.size();
    }

    // Read-only, whole-container iteration — every verified call site only
    // does this after the parallel region that populated the set has
    // finished (e.g. copying into a plain std::unordered_set), so these are
    // intentionally unguarded (same rationale as concurrent_vector.h).
    iterator begin() { return m_set.begin(); }
    const_iterator begin() const { return m_set.begin(); }
    iterator end() { return m_set.end(); }
    const_iterator end() const { return m_set.end(); }

private:
    Base m_set;
    mutable std::mutex m_mutex;
};

} // namespace tbb
