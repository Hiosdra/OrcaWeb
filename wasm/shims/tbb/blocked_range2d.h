#pragma once
#include "blocked_range.h"

namespace tbb {

template<typename RowValue, typename ColValue = RowValue>
class blocked_range2d {
public:
    typedef blocked_range<RowValue> row_range_type;
    typedef blocked_range<ColValue> col_range_type;

    blocked_range2d(RowValue row_begin, RowValue row_end,
                    ColValue col_begin, ColValue col_end)
        : rows_(row_begin, row_end), cols_(col_begin, col_end) {}

    blocked_range2d(RowValue row_begin, RowValue row_end, typename row_range_type::size_type row_grainsize,
                    ColValue col_begin, ColValue col_end, typename col_range_type::size_type col_grainsize)
        : rows_(row_begin, row_end, row_grainsize), cols_(col_begin, col_end, col_grainsize) {}

    const row_range_type& rows() const { return rows_; }
    const col_range_type& cols() const { return cols_; }

    bool empty() const { return rows_.empty() || cols_.empty(); }

private:
    row_range_type rows_;
    col_range_type cols_;
};

} // namespace tbb
