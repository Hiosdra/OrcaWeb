#pragma once
#include <unordered_set>

namespace tbb {

template<typename Key, typename Hash = std::hash<Key>,
         typename KeyEqual = std::equal_to<Key>,
         typename Allocator = std::allocator<Key>>
using concurrent_unordered_set = std::unordered_set<Key, Hash, KeyEqual, Allocator>;

} // namespace tbb
