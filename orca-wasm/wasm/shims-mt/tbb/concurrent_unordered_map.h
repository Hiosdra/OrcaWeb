#pragma once
#include <mutex>
#include <memory>
#include <type_traits>
#include <unordered_map>
#include <utility>

namespace tbb {

// Real libslic3r usage (MT-PLAN.md Phase 0, TreeSupport.hpp/.cpp) is a
// classic memoizing cache: `find(key)`, and if `it == end()` compute + call
// `insert({key, value})`. That pattern is racy against a plain mutex-guarded
// find()/insert() pair unless something also prevents the *iterator* `find()`
// returns from being invalidated by another thread's concurrent insert()
// before the caller dereferences `it->second` — std::unordered_map only
// guarantees references/pointers to existing elements survive a
// rehash-triggering insert, not iterators to them.
//
// The wrapper iterator stores a pointer to the element node instead of the
// standard iterator returned by find(). Element pointers survive rehash, so
// callers can safely dereference a successful find() while another thread
// inserts and grows the bucket array.
template<typename Key, typename T, typename Hash = std::hash<Key>,
         typename KeyEqual = std::equal_to<Key>,
         typename Allocator = std::allocator<std::pair<const Key, T>>>
class concurrent_unordered_map {
    using Base = std::unordered_map<Key, T, Hash, KeyEqual, Allocator>;
public:
    using value_type     = typename Base::value_type;
    using size_type      = typename Base::size_type;

    template<bool Const>
    class stable_iterator {
        using pointer = std::conditional_t<Const, const value_type*, value_type*>;
    public:
        stable_iterator() = default;
        explicit stable_iterator(pointer value) : m_value(value) {}
        std::conditional_t<Const, const value_type&, value_type&> operator*() const { return *m_value; }
        pointer operator->() const { return m_value; }
        friend bool operator==(stable_iterator lhs, stable_iterator rhs) { return lhs.m_value == rhs.m_value; }
        friend bool operator!=(stable_iterator lhs, stable_iterator rhs) { return !(lhs == rhs); }
    private:
        pointer m_value = nullptr;
    };

    using iterator = stable_iterator<false>;
    using const_iterator = stable_iterator<true>;

    concurrent_unordered_map() { m_map.reserve(k_initial_buckets); }
    concurrent_unordered_map(const concurrent_unordered_map& other) {
        std::lock_guard<std::mutex> lk(other.m_mutex);
        m_map = other.m_map;
    }
    concurrent_unordered_map(concurrent_unordered_map&& other) {
        std::lock_guard<std::mutex> lk(other.m_mutex);
        m_map = std::move(other.m_map);
    }
    concurrent_unordered_map& operator=(const concurrent_unordered_map& other) {
        if (this == &other) return *this;
        std::scoped_lock lk(m_mutex, other.m_mutex);
        m_map = other.m_map;
        return *this;
    }
    concurrent_unordered_map& operator=(concurrent_unordered_map&& other) {
        if (this == &other) return *this;
        std::scoped_lock lk(m_mutex, other.m_mutex);
        m_map = std::move(other.m_map);
        return *this;
    }

    iterator find(const Key& key) {
        std::lock_guard<std::mutex> lk(m_mutex);
        auto it = m_map.find(key);
        return iterator(it == m_map.end() ? nullptr : std::addressof(*it));
    }
    const_iterator find(const Key& key) const {
        std::lock_guard<std::mutex> lk(m_mutex);
        auto it = m_map.find(key);
        return const_iterator(it == m_map.end() ? nullptr : std::addressof(*it));
    }
    // A null node pointer is the stable end sentinel.
    iterator end() { return iterator(); }
    const_iterator end() const { return const_iterator(); }

    std::pair<iterator, bool> insert(const value_type& value) {
        std::lock_guard<std::mutex> lk(m_mutex);
        maybe_reserve_more();
        auto [it, inserted] = m_map.insert(value);
        return {iterator(std::addressof(*it)), inserted};
    }
    std::pair<iterator, bool> insert(value_type&& value) {
        std::lock_guard<std::mutex> lk(m_mutex);
        maybe_reserve_more();
        auto [it, inserted] = m_map.insert(std::move(value));
        return {iterator(std::addressof(*it)), inserted};
    }

    T& operator[](const Key& key) {
        std::lock_guard<std::mutex> lk(m_mutex);
        maybe_reserve_more();
        return m_map[key];
    }

    size_type count(const Key& key) const {
        std::lock_guard<std::mutex> lk(m_mutex);
        return m_map.count(key);
    }
    size_type size() const {
        std::lock_guard<std::mutex> lk(m_mutex);
        return m_map.size();
    }

private:
    // Grow ahead of the standard load-factor threshold to reduce rehash work.
    void maybe_reserve_more() {
        if (m_map.size() + 1 > m_map.bucket_count() * m_map.max_load_factor() / 2) {
            m_map.reserve(m_map.bucket_count() * 4);
        }
    }
    static constexpr size_type k_initial_buckets = 256;

    Base m_map;
    mutable std::mutex m_mutex;
};

// Real TBB's concurrent_hash_map has a different (accessor-based) API that
// nothing in libslic3r actually uses (MT-PLAN.md Phase 0 found zero call
// sites exercising accessor semantics) — alias to the same safe map.
template<typename Key, typename T, typename Hash = std::hash<Key>,
         typename KeyEqual = std::equal_to<Key>,
         typename Allocator = std::allocator<std::pair<const Key, T>>>
using concurrent_hash_map = concurrent_unordered_map<Key, T, Hash, KeyEqual, Allocator>;

} // namespace tbb
