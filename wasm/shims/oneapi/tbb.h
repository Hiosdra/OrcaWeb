// Redirect oneapi/tbb.h includes to our tbb shims
#pragma once
#include "../tbb/tbb.h"

namespace oneapi {
namespace tbb {
    using namespace ::tbb;
}
}
