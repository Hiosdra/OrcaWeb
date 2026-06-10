#pragma once
#include <vector>
#include <memory>

namespace tbb {

template<typename T, typename Allocator = std::allocator<T>>
class concurrent_vector : public std::vector<T, Allocator> {
    using Base = std::vector<T, Allocator>;
public:
    using Base::Base;
    using iterator       = typename Base::iterator;
    using const_iterator = typename Base::const_iterator;
    using size_type      = typename Base::size_type;
    using reference      = typename Base::reference;

    iterator grow_by(size_type n) {
        size_type old_size = this->size();
        this->resize(old_size + n);
        return this->begin() + static_cast<std::ptrdiff_t>(old_size);
    }
    iterator grow_by(size_type n, const T& val) {
        size_type old_size = this->size();
        this->resize(old_size + n, val);
        return this->begin() + static_cast<std::ptrdiff_t>(old_size);
    }
    iterator grow_to_at_least(size_type n) {
        if (this->size() < n) this->resize(n);
        return this->begin();
    }

    // TBB concurrent_vector::push_back returns a reference, not void.
    reference push_back(const T& val) {
        Base::push_back(val);
        return this->back();
    }
    reference push_back(T&& val) {
        Base::push_back(std::move(val));
        return this->back();
    }
};

} // namespace tbb
