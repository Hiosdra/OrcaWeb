// Umbrella TBB shim header — pulls in all stubs used by OrcaSlicer.
#pragma once
#include "blocked_range.h"
#include "parallel_for.h"
#include "parallel_reduce.h"
#include "parallel_invoke.h"
#include "parallel_pipeline.h"
#include "task_group.h"
#include "task_arena.h"
#include "spin_mutex.h"
#include "concurrent_vector.h"
#include "concurrent_unordered_map.h"
#include "global_control.h"

// oneapi/tbb subheaders that OrcaSlicer may include
namespace oneapi { namespace tbb {} }
namespace tbb {
    // Bring oneapi::tbb aliases into tbb namespace
}
