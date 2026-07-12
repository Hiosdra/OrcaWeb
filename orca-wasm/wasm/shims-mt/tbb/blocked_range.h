#pragma once
#include <cstddef>
#include <iterator>

namespace tbb {

struct split {};
struct proportional_split { std::size_t left, right; };

template<typename Value>
class blocked_range {
public:
    using value_type = Value;
    using size_type  = std::size_t;
    using const_iterator = Value;
    using iterator       = Value;

    blocked_range() : m_begin(), m_end(), m_grainsize(1) {}
    blocked_range(Value b, Value e, size_type g = 1)
        : m_begin(b), m_end(e), m_grainsize(g) {}
    // Split constructor — WASM never actually splits, just satisfies the API.
    blocked_range(blocked_range& r, split)
        : m_begin(r.m_end), m_end(r.m_end), m_grainsize(r.m_grainsize) {}
    blocked_range(blocked_range& r, proportional_split)
        : blocked_range(r, split{}) {}

    Value begin() const { return m_begin; }
    Value end()   const { return m_end;   }
    size_type size()  const { return static_cast<size_type>(m_end - m_begin); }
    size_type grainsize() const { return m_grainsize; }
    bool empty()        const { return m_begin >= m_end; }
    bool is_divisible() const { return false; }

private:
    Value     m_begin, m_end;
    size_type m_grainsize;
};

template<typename RowValue, typename ColValue = RowValue>
class blocked_range2d {
public:
    using row_range_type = blocked_range<RowValue>;
    using col_range_type = blocked_range<ColValue>;

    blocked_range2d() = default;
    blocked_range2d(RowValue rb, RowValue re, ColValue cb, ColValue ce)
        : m_rows(rb, re), m_cols(cb, ce) {}
    blocked_range2d(RowValue rb, RowValue re, std::size_t rg,
                    ColValue cb, ColValue ce, std::size_t cg)
        : m_rows(rb, re, rg), m_cols(cb, ce, cg) {}
    blocked_range2d(blocked_range2d& r, split) : m_rows(r.m_rows), m_cols(r.m_cols) {}

    const row_range_type& rows() const { return m_rows; }
    const col_range_type& cols() const { return m_cols; }
    bool empty()        const { return m_rows.empty() || m_cols.empty(); }
    bool is_divisible() const { return false; }

private:
    row_range_type m_rows;
    col_range_type m_cols;
};

} // namespace tbb
